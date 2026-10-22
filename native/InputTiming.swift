import Cocoa

final class InputTimingMonitor {
    typealias Context = (pid: Int64, revision: Int64)
    private var monitor: Any?
    private var typingTimer: Timer?
    private var scrollTimer: Timer?
    private var typingStart: Int64?
    private var typingEnd: Int64 = 0
    private var scrollingStart: Int64?
    private var scrollingEnd: Int64 = 0
    private var typingContext: Context?
    private var scrollingContext: Context?
    private let context: () -> Context?
    private let emit: (String, [String: Any], Int64?) -> Void

    init(context: @escaping () -> Context?, emit: @escaping (String, [String: Any], Int64?) -> Void) {
        self.context = context
        self.emit = emit
    }

    func start() {
        stop()
        guard CGPreflightListenEventAccess(), AXIsProcessTrusted() else { return }
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel]) { [weak self] event in
            self?.receive(event.type)
        }
    }

    func reset() {
        typingTimer?.invalidate(); typingTimer = nil
        scrollTimer?.invalidate(); scrollTimer = nil
        typingStart = nil; scrollingStart = nil
        typingContext = nil; scrollingContext = nil
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        reset()
    }

    private func receive(_ type: NSEvent.EventType) {
        // Only inspect the event category; never read characters, keyCode or clipboard.
        guard let current = context() else { reset(); return }
        let timestamp = nowMs()
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            emitTiming("click", started: timestamp, ended: timestamp, quiet: 0, context: current)
        case .keyDown:
            if typingContext?.pid != current.pid || typingContext?.revision != current.revision { typingStart = nil }
            typingStart = typingStart ?? timestamp
            typingEnd = timestamp
            typingContext = current
            typingTimer?.invalidate()
            typingTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in self?.flushTyping() }
        case .scrollWheel:
            if scrollingContext?.pid != current.pid || scrollingContext?.revision != current.revision { scrollingStart = nil }
            scrollingStart = scrollingStart ?? timestamp
            scrollingEnd = timestamp
            scrollingContext = current
            scrollTimer?.invalidate()
            scrollTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in self?.flushScrolling() }
        default: break
        }
    }

    private func emitTiming(_ trigger: String, started: Int64, ended: Int64, quiet: Int64, context: Context) {
        emit("input.timing", ["trigger": trigger, "contextRevision": context.revision,
                              "activityStartedAt": started, "activityEndedAt": ended, "quietDurationMs": quiet], context.pid)
    }

    private func flushTyping() {
        defer { typingStart = nil; typingContext = nil; typingTimer = nil }
        guard let start = typingStart, let original = typingContext, let current = context(),
              current.pid == original.pid, current.revision == original.revision else { return }
        emitTiming("typing_pause", started: start, ended: typingEnd, quiet: max(0, nowMs() - typingEnd), context: original)
    }

    private func flushScrolling() {
        defer { scrollingStart = nil; scrollingContext = nil; scrollTimer = nil }
        guard let start = scrollingStart, let original = scrollingContext, let current = context(),
              current.pid == original.pid, current.revision == original.revision else { return }
        emitTiming("scroll_stop", started: start, ended: scrollingEnd, quiet: max(0, nowMs() - scrollingEnd), context: original)
    }
}
