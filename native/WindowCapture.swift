// SPDX-License-Identifier: GPL-3.0-or-later
// PNG image-destination setup adapted from MemoryLane v1.5.10 screenshot.swift L87-115.
// Commit f3157d54524e647d32f7decd186ee00cac9f72d5.
// Changes: memory output, specified-window single shot, strict pre/post visibility and token-only staging.
import Cocoa
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import CryptoKit

func captureWindow(_ command: HelperCommand, staging: StagingArea) async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else {
        throw HelperFailure(code: "PERMISSION_SCREEN", stage: "capture", retryable: false)
    }
    guard let pid = HelperCommand.integer(command.raw["pid"]),
          let windowID = HelperCommand.integer(command.raw["windowId"]),
          command.raw["observationId"] is String,
          let outputToken = command.payload["outputToken"] as? String else {
        throw HelperFailure(code: "INVALID_COMMAND", stage: "capture", retryable: false)
    }
    _ = try staging.url(for: outputToken)
    let before = try currentWindowContext(expectedPID: pid, expectedWindowID: windowID, verifyVisibility: true, includeTitle: true)
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let candidates = content.windows.filter { Int64($0.windowID) == windowID && Int64($0.owningApplication?.processID ?? 0) == pid && $0.isOnScreen }
    guard candidates.count == 1 else {
        throw HelperFailure(code: "WINDOW_AMBIGUOUS", stage: "capture", retryable: true)
    }
    let window = candidates[0]
    let expected = before["bounds"] as? [String: Double] ?? [:]
    guard abs(window.frame.minX - (expected["x"] ?? .infinity)) <= 1,
          abs(window.frame.minY - (expected["y"] ?? .infinity)) <= 1,
          abs(window.frame.width - (expected["width"] ?? .infinity)) <= 1,
          abs(window.frame.height - (expected["height"] ?? .infinity)) <= 1 else {
        throw HelperFailure(code: "CONTEXT_CHANGED", stage: "capture", retryable: true)
    }
    try Task.checkCancellation()
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    configuration.width = min(16384, max(1, Int(window.frame.width * 2)))
    configuration.height = min(16384, max(1, Int(window.frame.height * 2)))
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    let observedAt = nowMs()
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    try Task.checkCancellation()
    let after = try currentWindowContext(expectedPID: pid, expectedWindowID: windowID, verifyVisibility: true, includeTitle: true)
    guard sameWindowContext(before, after) else {
        throw HelperFailure(code: "CONTEXT_CHANGED", stage: "capture", retryable: true)
    }
    let buffer = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(buffer, UTType.png.identifier as CFString, 1, nil) else {
        throw HelperFailure(code: "IO_ERROR", stage: "encode", retryable: false)
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination), buffer.length <= 32 * 1024 * 1024 else {
        throw HelperFailure(code: "IMAGE_TOO_LARGE", stage: "encode", retryable: false)
    }
    let data = buffer as Data
    guard command.deadlineAt > nowMs() else { throw HelperFailure(code: "TIMEOUT", stage: "capture", retryable: true) }
    try Task.checkCancellation()
    try staging.write(data, token: outputToken)
    return ["outputToken": outputToken, "sha256": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
            "mime": "image/png", "width": image.width, "height": image.height, "byteSize": data.count,
            "observedAt": observedAt, "contextBefore": before, "contextAfter": after, "visibilityStatus": "verified"]
}
