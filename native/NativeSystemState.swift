import Cocoa

final class NativeSystemState {
    static let shared = NativeSystemState()
    private(set) var sleeping = false
    private var tokens: [NSObjectProtocol] = []
    private init() {
        let center = NSWorkspace.shared.notificationCenter
        tokens.append(center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in self?.sleeping = true })
        tokens.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.sleeping = false })
    }
}
