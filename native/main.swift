import Cocoa
import ApplicationServices
import Darwin

func statusPayload() -> [String: Any] {
    let screen = CGPreflightScreenCaptureAccess() ? "granted" : "unknown"
    let accessibility = AXIsProcessTrusted() ? "granted" : "unknown"
    let input = CGPreflightListenEventAccess() ? "granted" : "unknown"
    func capability(_ permission: String, requires: Bool = false, reason: String? = nil) -> [String: Any] {
        ["supported": true, "permission": permission, "state": requires ? "permission_required" : "ready",
         "reason": reason as Any? ?? NSNull()]
    }
    return [
        "helperVersion": helperVersion, "minimumMacOS": "14.0", "architecture": "arm64",
        "permissions": ["screen": screen, "accessibility": accessibility, "inputMonitoring": input],
        "permissionReasons": ["screen": screen == "granted" ? NSNull() : "permission_not_granted" as Any,
                              "accessibility": accessibility == "granted" ? NSNull() : "permission_not_granted" as Any,
                              "inputMonitoring": input == "granted" ? NSNull() : "permission_not_granted" as Any],
        "capabilities": [
            "windowEvents": capability("not_required", reason: accessibility == "granted" ? nil : "AX_EVENTS_UNAVAILABLE"),
            "windowCapture": capability(screen, requires: screen != "granted" || accessibility != "granted",
                                        reason: screen != "granted" ? "PERMISSION_SCREEN" : accessibility != "granted" ? "PERMISSION_AX" : nil),
            "accessibilityText": capability(accessibility, requires: accessibility != "granted", reason: accessibility == "granted" ? nil : "PERMISSION_AX"),
            "visionOcr": capability("not_required"),
            "inputTiming": capability(input, requires: input != "granted" || accessibility != "granted",
                                      reason: input != "granted" || accessibility != "granted" ? "PERMISSION_INPUT" : nil)
        ],
        "foundationMethods": ["hello", "status", "permissions.request", "frontmost", "capture.preflight", "observe", "capture", "extract", "ocr", "cancel", "shutdown"],
        "captureStarted": false
    ]
}

final class HelperRuntime {
    private var sessionID: String?
    private var role: String?
    private var generation: Int64 = 0
    private var staging: StagingArea?
    private var listener: WindowListener?
    private var sequence: Int64 = 0
    private var cache: [String: (Data, [String: Any])] = [:]
    private var cacheOrder: [String] = []
    private var fingerprints: [String: Data] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    private var canceled = Set<String>()
    private var reachedEOF = false
    private var shuttingDown = false

    func handleLine(_ line: Data) {
        let startedAt = nowMs()
        var raw: [String: Any] = [:]
        var parsed: HelperCommand?
        do {
            guard let object = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                throw HelperFailure(code: "INVALID_COMMAND", stage: "protocol", retryable: false)
            }
            raw = object
            let command = try HelperCommand(raw)
            parsed = command
            let fingerprint = try JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys])
            if let existing = cache[command.requestID] {
                guard existing.0 == fingerprint else { throw HelperFailure(code: "REQUEST_CONFLICT", stage: "protocol", retryable: false) }
                emit(existing.1)
                return
            }
            if let existing = fingerprints[command.requestID] {
                guard existing == fingerprint else { throw HelperFailure(code: "REQUEST_CONFLICT", stage: "protocol", retryable: false) }
                emit(resultEnvelope(command, startedAt: startedAt, status: "accepted"))
                return
            }
            guard !shuttingDown, command.deadlineAt > startedAt else {
                throw HelperFailure(code: "TIMEOUT", stage: "dispatch", retryable: true)
            }
            guard tasks.count < 16 || ["cancel", "shutdown"].contains(command.method) else {
                throw HelperFailure(code: "QUEUE_FULL", stage: "dispatch", retryable: true)
            }
            if let sessionID {
                guard sessionID == command.sessionID, command.generation >= generation else {
                    throw HelperFailure(code: "STALE_SESSION", stage: "dispatch", retryable: false)
                }
                if command.generation > generation {
                    listener?.stop(); listener = nil
                    for (id, task) in tasks { canceled.insert(id); task.cancel() }
                }
            } else if command.method != "hello" {
                throw HelperFailure(code: "HELLO_REQUIRED", stage: "dispatch", retryable: false)
            }
            generation = command.generation
            fingerprints[command.requestID] = fingerprint
            tasks[command.requestID] = Task { @MainActor in await self.execute(command, startedAt: startedAt) }
        } catch {
            let failure = error as? HelperFailure ?? HelperFailure(code: "INVALID_COMMAND", stage: "protocol", retryable: false)
            emit(resultEnvelope(parsed, raw: raw, startedAt: startedAt, status: failure.code == "TIMEOUT" ? "timeout" : "failed", failure: failure))
        }
    }

    @MainActor private func execute(_ command: HelperCommand, startedAt: Int64) async {
        var outputToken: String?
        do {
            var payload: [String: Any]
            switch command.method {
            case "hello":
                guard let requestedRole = command.payload["role"] as? String, ["executor", "listener"].contains(requestedRole) else {
                    throw HelperFailure(code: "INVALID_ROLE", stage: "hello", retryable: false)
                }
                if let path = command.payload["stagingRoot"] as? String { staging = try StagingArea(path: path) }
                sessionID = command.sessionID
                role = requestedRole
                payload = statusPayload()
                payload["role"] = requestedRole
            case "status": payload = statusPayload()
            case "permissions.request":
                try requireExecutor()
                guard let kind = command.payload["kind"] as? String else {
                    throw HelperFailure(code: "INVALID_COMMAND", stage: "permissions", retryable: false)
                }
                // Only this explicit command prompts. Status probes remain read-only.
                let granted: Bool
                switch kind {
                case "screen": granted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
                case "accessibility":
                    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                    granted = AXIsProcessTrustedWithOptions(options)
                case "inputMonitoring": granted = CGPreflightListenEventAccess() || CGRequestListenEventAccess()
                default: throw HelperFailure(code: "INVALID_COMMAND", stage: "permissions", retryable: false)
                }
                payload = ["kind": kind, "requested": true, "granted": granted]
            case "frontmost":
                try requireExecutor()
                payload = try currentWindowContext()
            case "capture.preflight":
                try requireExecutor()
                guard CGPreflightScreenCaptureAccess() else { throw HelperFailure(code: "PERMISSION_SCREEN", stage: "preflight", retryable: false) }
                let identity = try observationIdentity(command, requireObservation: false)
                payload = try currentWindowContext(expectedPID: identity.0, expectedWindowID: identity.1, verifyVisibility: true, includeTitle: true)
            case "observe":
                guard role == "listener", command.payload["allowedBundleIds"] is [String], command.payload["excludedBundleIds"] is [String] else {
                    throw HelperFailure(code: "INVALID_COMMAND", stage: "observe", retryable: false)
                }
                listener?.stop()
                listener = WindowListener(command: command) { [weak self] method, payload, pid, state in
                    self?.event(command, method: method, payload: payload, pid: pid, state: state)
                }
                payload = try listener!.start()
            case "capture":
                try requireExecutor()
                _ = try observationIdentity(command)
                guard let staging else { throw HelperFailure(code: "STAGING_REQUIRED", stage: "capture", retryable: false) }
                outputToken = command.payload["outputToken"] as? String
                payload = try await captureWindow(command, staging: staging)
            case "extract":
                try requireExecutor()
                _ = try observationIdentity(command)
                payload = try extractAccessibilityText(command)
            case "ocr":
                try requireExecutor()
                _ = try observationIdentity(command)
                guard let staging else { throw HelperFailure(code: "STAGING_REQUIRED", stage: "ocr", retryable: false) }
                payload = try recognizeText(command, staging: staging)
            case "cancel":
                guard let target = command.payload["targetRequestId"] as? String, UUID(uuidString: target) != nil else {
                    throw HelperFailure(code: "INVALID_COMMAND", stage: "cancel", retryable: false)
                }
                if let task = tasks[target] { canceled.insert(target); task.cancel() }
                payload = ["canceled": true, "targetRequestId": target]
            case "shutdown":
                shuttingDown = true
                listener?.stop(); listener = nil
                for (id, task) in tasks where id != command.requestID { canceled.insert(id); task.cancel() }
                payload = ["shutdown": true]
            default:
                throw HelperFailure(code: "METHOD_UNSUPPORTED", stage: "protocol", retryable: false)
            }
            try Task.checkCancellation()
            guard !canceled.contains(command.requestID), command.generation == generation else {
                throw HelperFailure(code: "CANCELED", stage: command.method, retryable: false)
            }
            guard command.deadlineAt > nowMs() else { throw HelperFailure(code: "TIMEOUT", stage: command.method, retryable: true) }
            finish(command, startedAt: startedAt, status: payload["completeness"] as? String == "partial" ? "partial" : "ok", payload: payload)
        } catch {
            if let outputToken { staging?.discard(token: outputToken) }
            let failure = error is CancellationError ? HelperFailure(code: "CANCELED", stage: command.method, retryable: false) :
                error as? HelperFailure ?? HelperFailure(code: "NATIVE_ERROR", stage: command.method, retryable: true)
            let discarded = ["CONTEXT_CHANGED", "VISIBILITY_UNVERIFIED", "WINDOW_AMBIGUOUS", "SCREEN_LOCKED", "SYSTEM_SLEEPING"].contains(failure.code)
            finish(command, startedAt: startedAt, status: failure.code == "TIMEOUT" ? "timeout" : failure.code == "CANCELED" ? "canceled" : discarded ? "discarded" : "failed", failure: failure)
        }
        if command.method == "shutdown" { exit(0) }
        if reachedEOF && tasks.isEmpty { listener?.stop(); exit(0) }
    }

    private func requireExecutor() throws {
        guard role == "executor" else { throw HelperFailure(code: "ROLE_UNSUPPORTED", stage: "dispatch", retryable: false) }
    }

    private func observationIdentity(_ command: HelperCommand, requireObservation: Bool = true) throws -> (Int64, Int64) {
        guard let pid = HelperCommand.integer(command.raw["pid"]), pid > 0,
              let window = HelperCommand.integer(command.raw["windowId"]), window > 0,
              !requireObservation || command.raw["observationId"] is String else {
            throw HelperFailure(code: "INVALID_COMMAND", stage: command.method, retryable: false)
        }
        return (pid, window)
    }

    private func finish(_ command: HelperCommand, startedAt: Int64, status: String, payload: [String: Any] = [:], failure: HelperFailure? = nil) {
        let response = resultEnvelope(command, startedAt: startedAt, status: status, payload: payload, failure: failure)
        if let fingerprint = fingerprints.removeValue(forKey: command.requestID) {
            cache[command.requestID] = (fingerprint, response)
            cacheOrder.append(command.requestID)
            if cacheOrder.count > 128 { cache.removeValue(forKey: cacheOrder.removeFirst()) }
        }
        tasks.removeValue(forKey: command.requestID)
        canceled.remove(command.requestID)
        emit(response)
    }

    private func event(_ command: HelperCommand, method: String, payload: [String: Any], pid: Int64?, state: String) {
        guard command.generation == generation, !shuttingDown else { return }
        sequence += 1
        emit(["protocolVersion": protocolVersion, "helperSessionId": command.sessionID, "kind": "event",
              "method": method, "requestId": command.requestID, "generation": command.generation,
              "observationId": NSNull(), "pid": pid as Any? ?? NSNull(), "windowId": NSNull(),
              "observedAt": nowMs(), "sequence": sequence, "state": state, "payload": payload])
    }

    func inputClosed() {
        reachedEOF = true
        if tasks.isEmpty { listener?.stop(); exit(0) }
    }
}

guard CommandLine.arguments == [CommandLine.arguments[0], "--stdio"] else {
    FileHandle.standardError.write(Data("Usage: one-room-helper --stdio\n".utf8))
    exit(64)
}

let runtime = HelperRuntime()
_ = NativeSystemState.shared
DispatchQueue.global(qos: .userInitiated).async {
    var pending = Data()
    var discardingOversizeLine = false
    var readBuffer = [UInt8](repeating: 0, count: 4096)
    while true {
        let length = Darwin.read(STDIN_FILENO, &readBuffer, readBuffer.count)
        if length < 0 && errno == EINTR { continue }
        guard length > 0 else { break }
        for byte in readBuffer.prefix(length) {
            if byte == 10 {
                if discardingOversizeLine {
                    DispatchQueue.main.async {
                        emit(resultEnvelope(nil, startedAt: nowMs(), status: "failed",
                                            failure: HelperFailure(code: "PAYLOAD_TOO_LARGE", stage: "protocol", retryable: false)))
                    }
                } else if !pending.isEmpty {
                    let line = pending
                    DispatchQueue.main.async { runtime.handleLine(line) }
                }
                pending.removeAll(keepingCapacity: true)
                discardingOversizeLine = false
            } else if !discardingOversizeLine {
                if pending.count >= maximumLineBytes { pending.removeAll(keepingCapacity: true); discardingOversizeLine = true }
                else { pending.append(byte) }
            }
        }
    }
    if !pending.isEmpty {
        let line = pending
        DispatchQueue.main.async { runtime.handleLine(line) }
    }
    DispatchQueue.main.async { runtime.inputClosed() }
}
RunLoop.main.run()
