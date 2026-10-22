// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted from MemoryLane v1.5.10 app-watcher.swift, lines 22-79.
// Commit: f3157d54524e647d32f7decd186ee00cac9f72d5
// Changes: permission preflight, bounded AX timeout, checked types and strict visible-window matching.
import Cocoa
import ApplicationServices

func focusedWindow(forPid pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    let window = value as! AXUIElement
    AXUIElementSetMessagingTimeout(window, 0.25)
    return window
}

func focusedWindowFrame(_ window: AXUIElement) -> CGRect? {
    var position: AnyObject?
    var size: AnyObject?
    guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
          AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
          let position, let size,
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    let pointValue = position as! AXValue
    let sizeValue = size as! AXValue
    guard AXValueGetType(pointValue) == .cgPoint, AXValueGetType(sizeValue) == .cgSize else { return nil }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(pointValue, .cgPoint, &point), AXValueGetValue(sizeValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}

func rectPayload(_ rect: CGRect) -> [String: Double] {
    ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
}

func sessionIsLocked() -> Bool {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    return session?["CGSSessionScreenIsLocked"] as? Bool == true || session?[kCGSessionOnConsoleKey as String] as? Bool == false
}

func systemIsSleeping() -> Bool {
    if NativeSystemState.shared.sleeping { return true }
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return true }
    var displays = Array(repeating: CGDirectDisplayID(), count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return true }
    return displays.prefix(Int(count)).allSatisfy { CGDisplayIsAsleep($0) != 0 }
}

func sameWindowContext(_ before: [String: Any], _ after: [String: Any]) -> Bool {
    return (before["pid"] as? Int) == (after["pid"] as? Int) &&
           (before["windowId"] as? Int64) == (after["windowId"] as? Int64) &&
           (before["bundleId"] as? String) == (after["bundleId"] as? String) &&
           (before["windowTitle"] as? String) == (after["windowTitle"] as? String) &&
           NSDictionary(dictionary: before["bounds"] as? [String: Double] ?? [:]) ==
           NSDictionary(dictionary: after["bounds"] as? [String: Double] ?? [:])
}

func currentWindowContext(expectedPID: Int64? = nil, expectedWindowID: Int64? = nil,
                          verifyVisibility: Bool = false, includeTitle: Bool = false) throws -> [String: Any] {
    guard !sessionIsLocked() else {
        throw HelperFailure(code: "SCREEN_LOCKED", stage: "context", retryable: false)
    }
    guard !systemIsSleeping() else {
        throw HelperFailure(code: "SYSTEM_SLEEPING", stage: "context", retryable: false)
    }
    guard let app = NSWorkspace.shared.frontmostApplication else {
        throw HelperFailure(code: "WINDOW_AMBIGUOUS", stage: "context", retryable: true)
    }
    let pid = app.processIdentifier
    if let expectedPID, expectedPID != Int64(pid) {
        throw HelperFailure(code: "CONTEXT_CHANGED", stage: "context", retryable: true)
    }
    var context: [String: Any] = ["pid": Int(pid), "bundleId": app.bundleIdentifier as Any? ?? NSNull(),
                                "appName": app.localizedName as Any? ?? NSNull(), "frontmost": true,
                                "windowId": NSNull(), "windowTitle": NSNull(),
                                "visibility": "unverified", "observedAt": nowMs()]
    guard AXIsProcessTrusted() else {
        if verifyVisibility { throw HelperFailure(code: "PERMISSION_AX", stage: "preflight", retryable: false) }
        context["reason"] = "PERMISSION_AX"
        return context
    }
    guard let focused = focusedWindow(forPid: pid), let frame = focusedWindowFrame(focused),
          frame.width > 0, frame.height > 0 else {
        throw HelperFailure(code: "WINDOW_AMBIGUOUS", stage: "context", retryable: true)
    }
    var minimizedValue: AnyObject?
    guard AXUIElementCopyAttributeValue(focused, kAXMinimizedAttribute as CFString, &minimizedValue) == .success,
          let minimized = minimizedValue as? Bool, !minimized else {
        throw HelperFailure(code: "VISIBILITY_UNVERIFIED", stage: "preflight_minimized", retryable: true)
    }
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        throw HelperFailure(code: "VISIBILITY_UNVERIFIED", stage: "preflight", retryable: true)
    }
    func bounds(_ window: [String: Any]) -> CGRect? {
        guard let data = window[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: data)
    }
    let matches = windows.enumerated().filter { _, window in
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              let rect = bounds(window) else { return false }
        return abs(rect.minX - frame.minX) <= 1 && abs(rect.minY - frame.minY) <= 1 &&
               abs(rect.width - frame.width) <= 1 && abs(rect.height - frame.height) <= 1
    }
    guard matches.count == 1,
          let windowID = (matches[0].element[kCGWindowNumber as String] as? NSNumber)?.int64Value else {
        throw HelperFailure(code: "WINDOW_AMBIGUOUS", stage: "context", retryable: true)
    }
    if let expectedWindowID, expectedWindowID != windowID {
        throw HelperFailure(code: "CONTEXT_CHANGED", stage: "context", retryable: true)
    }
    context["windowId"] = windowID
    context["bounds"] = rectPayload(frame)
    context["minimized"] = false
    context["onScreen"] = true
    var titleValue: AnyObject?
    if includeTitle, AXUIElementCopyAttributeValue(focused, kAXTitleAttribute as CFString, &titleValue) == .success,
       let title = titleValue as? String { context["windowTitle"] = String(title.prefix(4096)) }
    if verifyVisibility {
        guard let alpha = (matches[0].element[kCGWindowAlpha as String] as? NSNumber)?.doubleValue,
              alpha.isFinite, alpha == 1 else {
            throw HelperFailure(code: "VISIBILITY_UNVERIFIED", stage: "preflight_translucent", retryable: true)
        }
        var displayCount: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &displayCount) == .success, displayCount > 0 else {
            throw HelperFailure(code: "VISIBILITY_UNVERIFIED", stage: "preflight_displays", retryable: true)
        }
        var displayIDs = Array(repeating: CGDirectDisplayID(), count: Int(displayCount))
        guard CGGetActiveDisplayList(displayCount, &displayIDs, &displayCount) == .success,
              displayIDs.prefix(Int(displayCount)).contains(where: { CGDisplayBounds($0).contains(frame) }) else {
            throw HelperFailure(code: "VISIBILITY_UNVERIFIED", stage: "preflight_offscreen", retryable: true)
        }
        for window in windows.prefix(matches[0].offset) {
            guard let rect = bounds(window) else {
                throw HelperFailure(code: "VISIBILITY_UNVERIFIED", stage: "preflight_geometry", retryable: true)
            }
            if rect.intersects(frame), (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0 {
                throw HelperFailure(code: "VISIBILITY_UNVERIFIED", stage: "preflight_overlay", retryable: true)
            }
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              let focusedAfter = focusedWindow(forPid: pid), focusedWindowFrame(focusedAfter) == frame else {
            throw HelperFailure(code: "CONTEXT_CHANGED", stage: "preflight", retryable: true)
        }
        // A preflight is only a candidate, never proof of a completed screenshot.
        context["visibility"] = "preflight_candidate"
        context["captureImplemented"] = true
    }
    return context
}
