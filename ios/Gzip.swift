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
/// Vendored from SwiftLogger (`Sources/Logger/Gzip.swift`), since diverged for
/// throughput: the CRC uses eight lookup tables instead of one and the chunk
/// loop reuses its buffers instead of allocating per read. The bytes written —
/// header, DEFLATE stream, trailer — are unchanged, and the CRC is still
/// CRC-32/ISO-HDLC, pinned by the published check value in the rotation tests
/// rather than by this file's word.
internal enum Gzip {

    /// Header: magic, DEFLATE method, no flags, no mtime, no extra flags, and
    /// an unknown OS (255) so the output is reproducible.
    private static let header: [UInt8] = [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]

    /// Size of each read from the source file. Two of these are live at a time,
    /// so peak memory is bounded regardless of how large the archive is.
    private static let chunkSize = 64 * 1024

    /// Compresses the file at `source` into a gzip file at `destination`,
    /// streaming in fixed-size chunks.
    ///
    /// Reads and deflates incrementally, so a rotation costs two 64 KB buffers
    /// no matter how big the log grew — a whole-buffer compress would hold
    /// roughly 2.5× a 10 MB archive in memory at once on the write queue. Both
    /// buffers are allocated once and reused for every chunk, and the bytes
    /// move through `read(2)`/`write(2)` directly rather than through a fresh
    /// `Data` per chunk; this loop runs on the writer queue that every append
    /// waits behind.
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

        let inputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
        defer { inputBuffer.deallocate() }
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
            // `read(2)` returns 0 at EOF and -1 on error, so the two must be
            // distinguished rather than collapsed. `EINTR` is neither.
            // (Recorded: not pinned — a mutant collapsing -1 into EOF survives
            // the suite, because inducing a read error on a healthy temp file
            // needs fault injection. The FileHandle throw this replaced was
            // equally unpinned; the reasoning above is the guard.)
            var readCount = 0
            repeat {
                readCount = Darwin.read(input.fileDescriptor, inputBuffer, chunkSize)
            } while readCount == -1 && errno == EINTR
            guard readCount >= 0 else { return false }

            let isLast = readCount == 0
            totalRead += readCount
            crc = crc32Update(crc, UnsafeRawBufferPointer(start: inputBuffer, count: readCount))

            stream.src_ptr = UnsafePointer(inputBuffer)
            stream.src_size = readCount
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
                    guard writeFully(output.fileDescriptor, outputBuffer, produced) else {
                        return false
                    }
                }
                if status == COMPRESSION_STATUS_END { break }
            } while stream.src_size > 0 || (isLast && stream.dst_size == 0)

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

    /// `write(2)` until every byte is out or the error is real. A short write
    /// is not a failure, and `EINTR` is not an error.
    private static func writeFully(
        _ descriptor: Int32, _ buffer: UnsafePointer<UInt8>, _ count: Int
    ) -> Bool {
        var done = 0
        while done < count {
            let wrote = Darwin.write(descriptor, buffer + done, count - done)
            if wrote > 0 { done += wrote; continue }
            if wrote == -1 && errno == EINTR { continue }
            return false
        }
        return true
    }

    // MARK: - CRC-32

    /// Slicing-by-8: `tables[0]` is the classic single byte-at-a-time table;
    /// `tables[k][b]` is the CRC of byte `b` followed by `k` zero bytes, so
    /// eight input bytes fold into the register with eight independent lookups
    /// instead of eight serially dependent ones. Same polynomial (0xEDB88320,
    /// reflected), same answer for every input — the published check value and
    /// the every-table-index vector in the rotation tests are the proof, and
    /// they cover both the 8-byte stride and the byte-at-a-time tail.
    private static let crcTables: [[UInt32]] = {
        var tables = Array(repeating: [UInt32](repeating: 0, count: 256), count: 8)
        for index in 0..<256 {
            var value = UInt32(index)
            for _ in 0..<8 {
                value = (value & 1 == 1) ? (0xEDB8_8320 ^ (value >> 1)) : (value >> 1)
            }
            tables[0][index] = value
        }
        for index in 0..<256 {
            var value = tables[0][index]
            for slice in 1..<8 {
                value = tables[0][Int(value & 0xFF)] ^ (value >> 8)
                tables[slice][index] = value
            }
        }
        return tables
    }()

    static func crc32(_ data: Data) -> UInt32 {
        var value: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { raw in
            value = crc32Update(value, raw)
        }
        return value ^ 0xFFFF_FFFF
    }

    /// Folds `buffer` into a running CRC-32. The caller supplies the initial
    /// `0xFFFF_FFFF` and applies the final inversion, so a checksum can be
    /// accumulated across streamed chunks.
    private static func crc32Update(_ crc: UInt32, _ buffer: UnsafeRawBufferPointer) -> UInt32 {
        guard let base = buffer.bindMemory(to: UInt8.self).baseAddress else { return crc }
        let count = buffer.count
        var value = crc
        var index = 0

        // Byte-by-byte composition of the two 32-bit halves keeps this
        // endian-independent; the table indices, not the load order, carry
        // the algorithm.
        while index + 8 <= count {
            let low = value
                ^ (UInt32(base[index])
                    | UInt32(base[index + 1]) << 8
                    | UInt32(base[index + 2]) << 16
                    | UInt32(base[index + 3]) << 24)
            let high = UInt32(base[index + 4])
                | UInt32(base[index + 5]) << 8
                | UInt32(base[index + 6]) << 16
                | UInt32(base[index + 7]) << 24
            value = crcTables[7][Int(low & 0xFF)]
                ^ crcTables[6][Int((low >> 8) & 0xFF)]
                ^ crcTables[5][Int((low >> 16) & 0xFF)]
                ^ crcTables[4][Int(low >> 24)]
                ^ crcTables[3][Int(high & 0xFF)]
                ^ crcTables[2][Int((high >> 8) & 0xFF)]
                ^ crcTables[1][Int((high >> 16) & 0xFF)]
                ^ crcTables[0][Int(high >> 24)]
            index += 8
        }
        while index < count {
            value = crcTables[0][Int((value ^ UInt32(base[index])) & 0xFF)] ^ (value >> 8)
            index += 1
        }
        return value
    }
}
#endif
