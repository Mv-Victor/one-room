import Cocoa

func fixtureEmit(_ payload: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: payload) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

final class FixtureOverlay: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class FixtureCanvas: NSView {
    var body = ""
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill(); bounds.fill()
        (body as NSString).draw(in: bounds.insetBy(dx: 8, dy: 8), withAttributes: [
            .font: NSFont.systemFont(ofSize: 24), .foregroundColor: NSColor.black
        ])
    }
    override func isAccessibilityElement() -> Bool { false }
}

final class FixtureDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var overlay: NSPanel?
    var initialFrame = NSRect.zero
    func activateFixture() {
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        activateFixture()
        return true
    }
    func control(_ request: [String: Any]) {
        guard let command = request["command"] as? String, let requestID = request["requestId"] as? String else { return }
        var result: [String: Any] = ["fixtureAck": requestID, "command": command]
        switch command {
        case "normal": window.level = .normal; activateFixture()
        case "elevated": window.level = .screenSaver; activateFixture()
        case "minimize": window.miniaturize(nil)
        case "offscreen":
            if let screen = NSScreen.main { window.setFrameOrigin(NSPoint(x: screen.frame.maxX + 100, y: screen.frame.minY + 100)) }
        case "restore":
            window.deminiaturize(nil); window.setFrame(initialFrame, display: true); activateFixture()
        case "overlay-opaque", "overlay-clear", "overlay-zero":
            overlay?.close()
            let panel = FixtureOverlay(contentRect: window.frame.insetBy(dx: 40, dy: 40), styleMask: .borderless,
                                       backing: .buffered, defer: false)
            panel.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
            panel.isOpaque = command == "overlay-opaque"
            panel.backgroundColor = command == "overlay-opaque" ? .red : .clear
            panel.alphaValue = command == "overlay-zero" ? 0 : 1
            panel.ignoresMouseEvents = true
            panel.hasShadow = false
            panel.isReleasedWhenClosed = false
            panel.orderFrontRegardless()
            overlay = panel
        case "overlay-hide": overlay?.close(); overlay = nil
        case "input":
            let permitted = CGPreflightPostEventAccess()
            result["postingPermitted"] = permitted
            guard permitted, NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() else {
                result["posted"] = false; fixtureEmit(result); return
            }
            // Deliver fixed test categories only to this process, never the current global target.
            let point = CGPoint(x: initialFrame.midX, y: (NSScreen.screens.first?.frame.maxY ?? 0) - initialFrame.midY)
            let events = [CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                          CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left),
                          CGEvent(keyboardEventSource: nil, virtualKey: 123, keyDown: true),
                          CGEvent(keyboardEventSource: nil, virtualKey: 123, keyDown: false),
                          CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 16, wheel2: 0, wheel3: 0)]
            for event in events { event?.postToPid(getpid()) }
            result["posted"] = true
        default: result["unsupported"] = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { fixtureEmit(result) }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 880, height: 560),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        // The OCR-only surface must not expose title-bar text through AX either.
        window.title = CommandLine.arguments.contains("--ocr-only") ? "" : "One Room Native Fixture"
        // Keep this isolated acceptance surface above existing desktop overlay tools.
        window.level = CommandLine.arguments.contains("--normal-level") ? .normal : .screenSaver
        window.backgroundColor = .white
        let text = NSTextView(frame: NSRect(x: 32, y: 32, width: 816, height: 496))
        text.isEditable = false
        text.isSelectable = true
        text.drawsBackground = true
        text.backgroundColor = .white
        text.textColor = .black
        text.font = NSFont.systemFont(ofSize: 24)
        text.string = """
        ONE ROOM NATIVE FIXTURE

        One Room screenshot and OCR acceptance.
        Only this isolated test window is authorized.

        工作日报：完成窗口采集、文本提取与本地保存。
        测试窗口正文用于验证中文与英文 OCR。
        """
        if CommandLine.arguments.contains("--ocr-only") || CommandLine.arguments.contains("--thin-ax") {
            let canvas = FixtureCanvas(frame: text.frame)
            canvas.body = text.string
            window.contentView?.addSubview(canvas)
            if CommandLine.arguments.contains("--thin-ax") {
                let label = NSTextField(labelWithString: "Fixture")
                label.frame = NSRect(x: 40, y: 8, width: 120, height: 24)
                window.contentView?.addSubview(label)
            }
        } else { window.contentView?.addSubview(text) }
        if let screen = NSScreen.main {
            window.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.maxX - 900, y: screen.visibleFrame.maxY - 20))
        } else { window.center() }
        initialFrame = window.frame
        activateFixture()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.activateFixture()
            var ready: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier,
                                      "windowId": self.window.windowNumber,
                                      "bundleId": Bundle.main.bundleIdentifier ?? "local.one-room.native-fixture"]
            if let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
               let index = windows.firstIndex(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == self.window.windowNumber }),
               let candidate = windows[index][kCGWindowBounds as String] as? NSDictionary,
               let frame = CGRect(dictionaryRepresentation: candidate) {
                ready["blockers"] = windows.prefix(index).compactMap { item -> [String: Any]? in
                    guard let bounds = item[kCGWindowBounds as String] as? NSDictionary,
                          let rect = CGRect(dictionaryRepresentation: bounds), rect.intersects(frame),
                          (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0 else { return nil }
                    return ["layer": item[kCGWindowLayer as String] ?? NSNull(), "owner": item[kCGWindowOwnerName as String] ?? NSNull(),
                            "alpha": item[kCGWindowAlpha as String] ?? NSNull(), "bounds": bounds]
                }
            }
            fixtureEmit(ready)
        }
    }
}

let application = NSApplication.shared
let delegate = FixtureDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(), let data = line.data(using: .utf8) {
        if let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            DispatchQueue.main.async { delegate.control(request) }
        }
    }
}
application.run()
