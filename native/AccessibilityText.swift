import Cocoa
import ApplicationServices

private func axValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}

func extractAccessibilityText(_ command: HelperCommand) throws -> [String: Any] {
    guard AXIsProcessTrusted() else { throw HelperFailure(code: "PERMISSION_AX", stage: "extract", retryable: false) }
    guard let pid = HelperCommand.integer(command.raw["pid"]),
          let windowID = HelperCommand.integer(command.raw["windowId"]) else {
        throw HelperFailure(code: "INVALID_COMMAND", stage: "extract", retryable: false)
    }
    let before = try currentWindowContext(expectedPID: pid, expectedWindowID: windowID, verifyVisibility: true, includeTitle: true)
    guard let window = focusedWindow(forPid: pid_t(pid)), let frame = focusedWindowFrame(window) else {
        throw HelperFailure(code: "WINDOW_AMBIGUOUS", stage: "extract", retryable: true)
    }
    let deadline = min(command.deadlineAt - 50, nowMs() + 1200)
    var queue: [(AXUIElement, Int, CGRect)] = [(window, 0, frame)]
    var index = 0
    var values: [String] = []
    var seenText = Set<String>()
    var total = 0
    var partial = false
    var bodyCount = 0
    let excludedRoles: Set<String> = ["AXToolbar", "AXMenuBar", "AXMenu", "AXSecureTextField"]
    while index < queue.count {
        if index >= 1500 || nowMs() >= deadline || total >= 65536 { partial = true; break }
        let (element, depth, parentClip) = queue[index]
        index += 1
        if depth > 20 { partial = true; continue }
        AXUIElementSetMessagingTimeout(element, 0.1)
        let role = axValue(element, kAXRoleAttribute) as? String ?? ""
        let subrole = axValue(element, kAXSubroleAttribute) as? String ?? ""
        if excludedRoles.contains(role) || subrole == "AXSecureTextField" ||
           (axValue(element, "AXHidden") as? Bool == true) ||
           (axValue(element, "AXProtectedContent") as? Bool == true) { continue }
        let elementFrame = focusedWindowFrame(element)
        var clip = parentClip
        if let elementFrame, elementFrame.width > 0, elementFrame.height > 0 {
            clip = parentClip.intersection(elementFrame)
            if clip.isNull || clip.isEmpty { continue }
        }
        if ["AXStaticText", "AXTextArea", "AXTextField"].contains(role),
           let elementFrame, parentClip.contains(elementFrame),
           var text = axValue(element, kAXValueAttribute) as? String {
            if role != "AXStaticText" {
                if let rangeObject = axValue(element, "AXVisibleCharacterRange"), CFGetTypeID(rangeObject) == AXValueGetTypeID() {
                    let value = rangeObject as! AXValue
                    var range = CFRange()
                    if AXValueGetType(value) == .cfRange, AXValueGetValue(value, .cfRange, &range),
                       range.location >= 0, range.length >= 0, range.location + range.length <= (text as NSString).length {
                        text = (text as NSString).substring(with: NSRange(location: range.location, length: range.length))
                    } else { text = ""; partial = true }
                } else { text = ""; partial = true }
            }
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty, seenText.insert(text).inserted {
                let bounded = String(text.prefix(max(0, 65536 - total)))
                values.append(bounded)
                total += bounded.count
                if role == "AXTextArea" || role == "AXStaticText" { bodyCount += bounded.count }
                if bounded.count < text.count { partial = true }
            }
        }
        let visible = axValue(element, "AXVisibleChildren") as? [AXUIElement]
        let children = visible ?? axValue(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        let capacity = max(0, 1500 - queue.count)
        if children.count > capacity { partial = true }
        queue.append(contentsOf: children.prefix(capacity).map { ($0, depth + 1, clip) })
    }
    let after = try currentWindowContext(expectedPID: pid, expectedWindowID: windowID, verifyVisibility: true, includeTitle: true)
    guard sameWindowContext(before, after) else {
        throw HelperFailure(code: "CONTEXT_CHANGED", stage: "extract", retryable: true)
    }
    let text = values.joined(separator: "\n")
    let completeness = text.isEmpty ? "empty" : partial ? "partial" : bodyCount < 80 ? "thin" : "complete"
    return ["source": "accessibility", "status": text.isEmpty ? "empty" : partial ? "partial" : "ready",
            "completeness": completeness, "text": text,
            "fallbackReason": completeness == "complete" ? NSNull() : "ax_\(completeness)" as Any,
            "observedAt": nowMs(), "contextBefore": before, "contextAfter": after, "nodeCount": index]
}
