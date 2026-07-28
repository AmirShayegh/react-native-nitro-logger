#if canImport(Compression)
import Foundation
import Compression

/// Produces gzip (RFC 1952) containers for rotated log archives.
///
/// Apple's Compression framework emits a *raw* DEFLATE stream for
/// `COMPRESSION_ZLIB` (RFC 1951) with no container around it, so writing a file
/// that `gunzip` and every other standard tool can open means supplying the
/// gzip header and the trailing CRC-32 and length ourselves.
///
/// Vendored unchanged from SwiftLogger (`Sources/Logger/Gzip.swift`). Kept
/// byte-identical on purpose: it is the piece with the least reason to diverge
/// and the most reason to stay diffable against the original.
internal enum Gzip {

    /// Header: magic, DEFLATE method, no flags, no mtime, no extra flags, and
    /// an unknown OS (255) so the output is reproducible.
    private static let header: [UInt8] = [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]

    /// Returns `data` as a gzip stream, or `nil` if compression fails.
    static func compress(_ data: Data) -> Data? {
        guard let deflated = deflate(data) else { return nil }

        var output = Data(capacity: deflated.count + 18)
        output.append(contentsOf: header)
        output.append(deflated)

        // Trailer: CRC-32 of the *uncompressed* data, then its length mod 2^32,
        // both little-endian.
        appendLittleEndian(&output, crc32(data))
        appendLittleEndian(&output, UInt32(truncatingIfNeeded: data.count))

        return output
    }

    /// Size of each read from the source file. Two of these are live at a time,
    /// so peak memory is bounded regardless of how large the archive is.
    private static let chunkSize = 64 * 1024

    /// Compresses the file at `source` into a gzip file at `destination`,
    /// streaming in fixed-size chunks.
    ///
    /// ``compress(_:)`` holds the whole input, the whole DEFLATE output, and
    /// the assembled container in memory at once — roughly 2.5× a 10 MB archive
    /// on the write queue. This reads and deflates incrementally instead, so a
    /// rotation costs two 64 KB buffers no matter how big the log grew.
    ///
    /// Returns `false` and removes any partial output if anything fails, so the
    /// caller can keep the uncompressed original.
    static func compressFile(at source: URL, to destination: URL) -> Bool {
        guard let input = try? FileHandle(forReadingFrom: source) else { return false }
        defer { try? input.close() }

        guard FileManager.default.createFile(atPath: destination.path, contents: nil),
              let output = try? FileHandle(forWritingTo: destination) else {
            try? FileManager.default.removeItem(at: destination)
            return false
        }

        var succeeded = false
        defer {
            try? output.close()
            if !succeeded {
                try? FileManager.default.removeItem(at: destination)
            }
        }

        guard (try? output.write(contentsOf: Data(header))) != nil else { return false }

        var stream = compression_stream(
            dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: -1)!, dst_size: 0,
            src_ptr: UnsafePointer<UInt8>(bitPattern: -1)!, src_size: 0,
            state: nil
        )
        guard compression_stream_init(&stream, COMPRESSION_STREAM_ENCODE, COMPRESSION_ZLIB)
                == COMPRESSION_STATUS_OK else { return false }
        defer { compression_stream_destroy(&stream) }

        let outputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
        defer { outputBuffer.deallocate() }

        var crc: UInt32 = 0xFFFF_FFFF
        var totalRead = 0

        while true {
            // A read error must NOT be treated as end-of-input. Doing so would
            // finalize the stream over a partial file, write a CRC and length
            // matching what was read, and return success — producing a .gz that
            // gunzip happily verifies while the caller deletes the complete
            // original. Silent truncation is far worse than a failed rotation.
            //
            // `read(upToCount:)` returns nil at EOF and throws on error, so the
            // two must be distinguished rather than collapsed with `try?`.
            let chunk: Data
            do {
                chunk = try input.read(upToCount: chunkSize) ?? Data()
            } catch {
                return false
            }
            let isLast = chunk.isEmpty
            totalRead += chunk.count
            crc = crc32Update(crc, chunk)

            let ok = chunk.withUnsafeBytes { raw -> Bool in
                // An empty Data has no base address; the encoder accepts a
                // zero-length source as long as the pointer is non-null.
                let base = raw.bindMemory(to: UInt8.self).baseAddress
                    ?? UnsafePointer<UInt8>(bitPattern: -1)!
                stream.src_ptr = base
                stream.src_size = chunk.count
                let flags = isLast ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0

                // One source chunk can expand into several output chunks, so
                // keep draining until the encoder stops filling the buffer.
                repeat {
                    stream.dst_ptr = outputBuffer
                    stream.dst_size = chunkSize
                    let status = compression_stream_process(&stream, flags)
                    guard status != COMPRESSION_STATUS_ERROR else { return false }

                    let produced = chunkSize - stream.dst_size
                    if produced > 0 {
                        let out = Data(bytes: outputBuffer, count: produced)
                        guard (try? output.write(contentsOf: out)) != nil else { return false }
                    }
                    if status == COMPRESSION_STATUS_END { break }
                } while stream.src_size > 0 || (isLast && stream.dst_size == 0)

                return true
            }
            guard ok else { return false }
            if isLast { break }
        }

        // Trailer: CRC-32 of the uncompressed bytes, then their length mod 2^32.
        var trailer = Data(capacity: 8)
        appendLittleEndian(&trailer, crc ^ 0xFFFF_FFFF)
        appendLittleEndian(&trailer, UInt32(truncatingIfNeeded: totalRead))
        guard (try? output.write(contentsOf: trailer)) != nil else { return false }

        succeeded = true
        return true
    }

    private static func appendLittleEndian(_ data: inout Data, _ value: UInt32) {
        withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }

    private static func deflate(_ data: Data) -> Data? {
        guard !data.isEmpty else { return Data() }

        // Incompressible input can grow slightly, so leave headroom rather than
        // letting the encode fail on a tight buffer.
        let capacity = data.count + (data.count / 2) + 64
        let destination = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
        defer { destination.deallocate() }

        let written = data.withUnsafeBytes { raw -> Int in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return compression_encode_buffer(
                destination, capacity,
                base, data.count,
                nil,
                COMPRESSION_ZLIB
            )
        }

        guard written > 0 else { return nil }
        return Data(bytes: destination, count: written)
    }

    // MARK: - CRC-32

    private static let crcTable: [UInt32] = {
        (0..<256).map { index -> UInt32 in
            var value = UInt32(index)
            for _ in 0..<8 {
                value = (value & 1 == 1) ? (0xEDB8_8320 ^ (value >> 1)) : (value >> 1)
            }
            return value
        }
    }()

    static func crc32(_ data: Data) -> UInt32 {
        crc32Update(0xFFFF_FFFF, data) ^ 0xFFFF_FFFF
    }

    /// Folds `data` into a running CRC-32. The caller supplies the initial
    /// `0xFFFF_FFFF` and applies the final inversion, so a checksum can be
    /// accumulated across streamed chunks.
    private static func crc32Update(_ crc: UInt32, _ data: Data) -> UInt32 {
        guard !data.isEmpty else { return crc }
        var value = crc
        data.withUnsafeBytes { raw in
            for byte in raw.bindMemory(to: UInt8.self) {
                value = crcTable[Int((value ^ UInt32(byte)) & 0xFF)] ^ (value >> 8)
            }
        }
        return value
    }
}
#endif
