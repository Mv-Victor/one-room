// SPDX-License-Identifier: GPL-3.0-or-later
// NSWorkspace activation / AXObserver setup and teardown adapted from MemoryLane
// v1.5.10 app-watcher.swift L285-465, commit f3157d54524e647d32f7decd186ee00cac9f72d5.
// Changes: notification-only JSONL, allow/exclude scope, heartbeat, lifecycle and no title/URL reads in callbacks.
import Cocoa
import ApplicationServices

final class WindowListener {
    private let command: HelperCommand
    private let emitEvent: (String, [String: Any], Int64?, String) -> Void
    private var tokens: [(NotificationCenter, NSObjectProtocol)] = []
    private var observer: AXObserver?
    private var titleWindow: AXUIElement?
    private var heartbeat: Timer?
    private var input: InputTimingMonitor?
    private let allowed: Set<String>
    private let excluded: Set<String>
    private let triggers: Set<String>
    private var observedPID: pid_t = 0
    private(set) var contextRevision: Int64 = 1
    private(set) var locked = sessionIsLocked()
    private(set) var sleeping = systemIsSleeping()

    init(command: HelperCommand, emit: @escaping (String, [String: Any], Int64?, String) -> Void) {
        self.command = command
        self.emitEvent = emit
        allowed = Set(command.payload["allowedBundleIds"] as? [String] ?? [])
        excluded = Set(command.payload["excludedBundleIds"] as? [String] ?? [])
        triggers = Set(command.payload["triggers"] as? [String] ?? [])
    }

    func start() throws -> [String: Any] {
        guard let heartbeatMs = HelperCommand.integer(command.payload["heartbeatMs"]), (100...60000).contains(heartbeatMs) else {
            throw HelperFailure(code: "INVALID_COMMAND", stage: "observe", retryable: false)
        }
        let workspace = NSWorkspace.shared.notificationCenter
        add(workspace, NSWorkspace.didActivateApplicationNotification) { [weak self] _ in self?.changed("app_switch") }
        add(workspace, NSWorkspace.willSleepNotification) { [weak self] _ in self?.system("sleep") }
        add(workspace, NSWorkspace.didWakeNotification) { [weak self] _ in self?.system("wake") }
        let distributed = DistributedNotificationCenter.default()
        add(distributed, Notification.Name("com.apple.screenIsLocked")) { [weak self] _ in self?.system("locked") }
        add(distributed, Notification.Name("com.apple.screenIsUnlocked")) { [weak self] _ in self?.system("unlocked") }
        heartbeat = Timer.scheduledTimer(withTimeInterval: Double(heartbeatMs) / 1000, repeats: true) { [weak self] _ in
            guard let self else { return }
            let actualLocked = sessionIsLocked()
            if actualLocked != self.locked { self.system(actualLocked ? "locked" : "unlocked") }
            let actualSleeping = systemIsSleeping()
            if actualSleeping != self.sleeping { self.system(actualSleeping ? "sleep" : "wake") }
            self.emitEvent("heartbeat", ["contextRevision": self.contextRevision, "screenLocked": self.locked, "sleeping": self.sleeping], nil, self.locked || self.sleeping ? "blocked" : "ready")
        }
        input = InputTimingMonitor(context: { [weak self] in
            guard let self, !self.locked, !self.sleeping, AXIsProcessTrusted(), CGPreflightListenEventAccess(),
                  let app = self.permittedApp() else { return nil }
            return (Int64(app.processIdentifier), self.contextRevision)
        }, emit: { [weak self] method, payload, pid in
            guard let self, self.triggers.contains(payload["trigger"] as? String ?? "") else { return }
            self.emitEvent(method, payload, pid, "ready")
        })
        input?.start()
        // Emit after observe's result so the client can establish the subscription first.
        DispatchQueue.main.async { [weak self] in self?.changed("app_switch") }
        return ["observing": true, "contextRevision": contextRevision, "heartbeatMs": heartbeatMs]
    }

    func stop() {
        input?.stop(); input = nil
        heartbeat?.invalidate(); heartbeat = nil
        for (center, token) in tokens { center.removeObserver(token) }
        tokens.removeAll()
        tearDownAXObserver()
    }

    private func add(_ center: NotificationCenter, _ name: Notification.Name, callback: @escaping (Notification) -> Void) {
        tokens.append((center, center.addObserver(forName: name, object: nil, queue: .main, using: callback)))
    }

    private func permittedApp() -> NSRunningApplication? {
        guard let app = NSWorkspace.shared.frontmostApplication, let bundle = app.bundleIdentifier,
              allowed.contains(bundle), !excluded.contains(bundle) else { return nil }
        return app
    }

    private func system(_ reason: String) {
        if reason == "locked" { locked = true }
        if reason == "unlocked" { locked = false }
        if reason == "sleep" { sleeping = true }
        if reason == "wake" { sleeping = false; locked = sessionIsLocked() }
        contextRevision += 1
        input?.reset()
        tearDownAXObserver()
        emitEvent("system.state", ["reason": reason], nil, locked || sleeping ? "blocked" : "ready")
        if !locked && !sleeping { changed("app_switch") }
    }

    private func changed(_ trigger: String) {
        if trigger != "content_changed" { contextRevision += 1; input?.reset() }
        guard !locked, !sleeping else { return }
        guard let app = permittedApp() else {
            tearDownAXObserver()
            // Only a stop signal for excluded/unallowed applications; no identity/title/body.
            emitEvent("window.changed", ["trigger": trigger, "contextRevision": contextRevision], nil, "blocked")
            return
        }
        if triggers.contains(trigger) {
            emitEvent("window.changed", ["trigger": trigger, "contextRevision": contextRevision], Int64(app.processIdentifier), "ready")
        }
        if observedPID != app.processIdentifier { setupAXObserver(forPid: app.processIdentifier) }
        else if trigger == "window_focus" { retargetTitle(forPid: app.processIdentifier) }
    }

    private func tearDownAXObserver() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil
        titleWindow = nil
        observedPID = 0
    }

    private func setupAXObserver(forPid pid: pid_t) {
        tearDownAXObserver()
        guard AXIsProcessTrusted() else { return }
        var created: AXObserver?
        let callback: AXObserverCallback = { _, _, notification, refcon in
            guard let refcon else { return }
            let listener = Unmanaged<WindowListener>.fromOpaque(refcon).takeUnretainedValue()
            let name = notification as String
            listener.changed(name == kAXFocusedWindowChangedNotification ? "window_focus" : name == kAXTitleChangedNotification ? "window_title" : "content_changed")
        }
        guard AXObserverCreate(pid, callback, &created) == .success, let created else { return }
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, 0.1)
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(created, appElement, kAXFocusedWindowChangedNotification as CFString, pointer)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
        observer = created
        observedPID = pid
        retargetTitle(forPid: pid)
    }

    private func retargetTitle(forPid pid: pid_t) {
        guard let observer else { return }
        if let titleWindow {
            AXObserverRemoveNotification(observer, titleWindow, kAXTitleChangedNotification as CFString)
            AXObserverRemoveNotification(observer, titleWindow, kAXValueChangedNotification as CFString)
        }
        guard let window = focusedWindow(forPid: pid) else { titleWindow = nil; return }
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(observer, window, kAXTitleChangedNotification as CFString, pointer)
        AXObserverAddNotification(observer, window, kAXValueChangedNotification as CFString, pointer)
        titleWindow = window
    }
}
