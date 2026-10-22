import Foundation
import Darwin

final class StagingArea {
    let root: URL

    init(path: String) throws {
        let candidate = URL(fileURLWithPath: path).standardizedFileURL
        var info = stat()
        guard path.hasPrefix("/"), candidate.path == candidate.resolvingSymlinksInPath().path,
              lstat(candidate.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o022 == 0 else {
            throw HelperFailure(code: "STAGING_INVALID", stage: "hello", retryable: false)
        }
        root = candidate
    }

    func url(for token: String) throws -> URL {
        guard UUID(uuidString: token) != nil else {
            throw HelperFailure(code: "INVALID_TOKEN", stage: "staging", retryable: false)
        }
        return root.appendingPathComponent("\(token).png", isDirectory: false)
    }

    func write(_ bytes: Data, token: String) throws {
        let destination = try url(for: token)
        let descriptor = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw HelperFailure(code: "IO_ERROR", stage: "staging", retryable: false) }
        var complete = false
        defer {
            close(descriptor)
            if !complete { unlink(destination.path) }
        }
        try bytes.withUnsafeBytes { buffer in
            var written = 0
            while written < buffer.count {
                let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: written), buffer.count - written)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw HelperFailure(code: "IO_ERROR", stage: "staging", retryable: false) }
                written += count
            }
        }
        guard fsync(descriptor) == 0 else { throw HelperFailure(code: "IO_ERROR", stage: "staging", retryable: false) }
        complete = true
    }

    func read(token: String) throws -> Data {
        let source = try url(for: token)
        let descriptor = open(source.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw HelperFailure(code: "IO_ERROR", stage: "ocr", retryable: false) }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_size > 0, info.st_size <= 32 * 1024 * 1024 else {
            throw HelperFailure(code: "INVALID_IMAGE", stage: "ocr", retryable: false)
        }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        return try file.readToEnd() ?? Data()
    }

    func discard(token: String) {
        if let destination = try? url(for: token) { unlink(destination.path) }
    }
}
