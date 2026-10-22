import Foundation
import CoreFoundation

let protocolVersion = 1
let helperVersion = "0.2.1-permissions"
let maximumLineBytes = 1_048_576

func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }

struct HelperFailure: Error {
    let code: String
    let stage: String
    let retryable: Bool
}

struct HelperCommand {
    let raw: [String: Any]
    let sessionID: String
    let requestID: String
    let generation: Int64
    let method: String
    let deadlineAt: Int64
    let payload: [String: Any]

    static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0,
              number.doubleValue <= 9_007_199_254_740_991 else { return nil }
        return number.int64Value
    }

    init(_ raw: [String: Any]) throws {
        let required = ["protocolVersion", "helperSessionId", "kind", "method", "requestId", "generation", "observationId", "pid", "windowId", "issuedAt", "deadlineAt", "payload"]
        guard required.allSatisfy({ raw.keys.contains($0) }),
              raw["kind"] as? String == "command",
              let sessionID = raw["helperSessionId"] as? String, UUID(uuidString: sessionID) != nil,
              let requestID = raw["requestId"] as? String, UUID(uuidString: requestID) != nil,
              let method = raw["method"] as? String,
              let generation = Self.integer(raw["generation"]), generation > 0,
              let issuedAt = Self.integer(raw["issuedAt"]),
              let deadlineAt = Self.integer(raw["deadlineAt"]), deadlineAt >= issuedAt,
              let payload = raw["payload"] as? [String: Any] else {
            throw HelperFailure(code: "INVALID_COMMAND", stage: "protocol", retryable: false)
        }
        guard Self.integer(raw["protocolVersion"]) == 1 else {
            throw HelperFailure(code: "PROTOCOL_UNSUPPORTED", stage: "protocol", retryable: false)
        }
        for field in ["pid", "windowId"] {
            guard raw[field] is NSNull || Self.integer(raw[field]) != nil else {
                throw HelperFailure(code: "INVALID_COMMAND", stage: "protocol", retryable: false)
            }
        }
        guard raw["observationId"] is NSNull || (raw["observationId"] as? String).flatMap(UUID.init(uuidString:)) != nil else {
            throw HelperFailure(code: "INVALID_COMMAND", stage: "protocol", retryable: false)
        }
        self.raw = raw
        self.sessionID = sessionID
        self.requestID = requestID
        self.generation = generation
        self.method = method
        self.deadlineAt = deadlineAt
        self.payload = payload
    }
}

func resultEnvelope(_ command: HelperCommand?, raw: [String: Any] = [:], startedAt: Int64,
                    status: String, payload: [String: Any] = [:], failure: HelperFailure? = nil) -> [String: Any] {
    let source = command?.raw ?? raw
    var result: [String: Any] = [
        "protocolVersion": protocolVersion,
        "helperSessionId": source["helperSessionId"] as? String ?? NSNull() as Any,
        "kind": "result",
        "method": source["method"] as? String ?? "invalid",
        "requestId": source["requestId"] as? String ?? NSNull() as Any,
        "generation": HelperCommand.integer(source["generation"]) as Any? ?? NSNull(),
        "observationId": source["observationId"] ?? NSNull(),
        "pid": source["pid"] ?? NSNull(),
        "windowId": source["windowId"] ?? NSNull(),
        "startedAt": startedAt,
        "finishedAt": nowMs(),
        "status": status,
        "payload": payload
    ]
    if let failure {
        result["error"] = ["code": failure.code, "stage": failure.stage, "retryable": failure.retryable,
                           "requestId": result["requestId"]!, "generation": result["generation"]!]
    }
    return result
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    guard data.count <= maximumLineBytes else {
        let failure = resultEnvelope(nil, raw: value, startedAt: nowMs(), status: "failed",
                                     failure: HelperFailure(code: "PAYLOAD_TOO_LARGE", stage: "protocol", retryable: false))
        if let encoded = try? JSONSerialization.data(withJSONObject: failure, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(encoded)
            FileHandle.standardOutput.write(Data([10]))
        }
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
