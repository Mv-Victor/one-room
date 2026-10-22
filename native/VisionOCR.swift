// SPDX-License-Identifier: GPL-3.0-or-later
// Recognition request/result pipeline adapted from MemoryLane v1.5.10 ocr.swift L28-54.
// Commit f3157d54524e647d32f7decd186ee00cac9f72d5.
// Changes: token-only original image, Chinese/English accurate recognition, bounded text and structured status.
import Cocoa
import Vision

func recognizeText(_ command: HelperCommand, staging: StagingArea) throws -> [String: Any] {
    guard let token = command.payload["inputToken"] as? String else {
        throw HelperFailure(code: "INVALID_COMMAND", stage: "ocr", retryable: false)
    }
    let data = try staging.read(token: token)
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) == 1,
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil), image.width <= 16384, image.height <= 16384 else {
        throw HelperFailure(code: "INVALID_IMAGE", stage: "ocr", retryable: false)
    }
    let requested = command.payload["languages"] as? [String] ?? ["zh-Hans", "en-US"]
    let allowed = Set(["zh-Hans", "zh-Hant", "en-US"])
    let languages = requested.filter { allowed.contains($0) }
    let effective = languages.isEmpty ? ["zh-Hans", "en-US"] : languages
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = effective
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    guard command.deadlineAt > nowMs() else { throw HelperFailure(code: "TIMEOUT", stage: "ocr", retryable: true) }
    try handler.perform([request])
    let recognized = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    let text = String(recognized.prefix(65536))
    let partial = text.count < recognized.count
    return ["source": "ocr", "status": text.isEmpty ? "empty" : partial ? "partial" : "ready",
            "completeness": text.isEmpty ? "empty" : partial ? "partial" : "complete", "text": text,
            "fallbackReason": partial ? "text_budget" : NSNull() as Any, "observedAt": nowMs(),
            "languages": effective, "inputToken": token]
}
