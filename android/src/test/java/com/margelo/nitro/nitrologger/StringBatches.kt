package com.margelo.nitro.nitrologger

/**
 * String conveniences over the `ByteArray`-typed production surface (0.4.0).
 *
 * `appendBatch` takes bytes now — encoding happens once, in TypeScript, and
 * crosses the bridge as an `ArrayBuffer`. Tests still speak in string
 * literals; these overloads pay the same `toByteArray` the production path
 * paid through 0.3.x and forward straight to the shipping method, so every
 * call site still exercises the real entry point and the real byte counts.
 */
fun LogFileWriter.append(
  handleId: Long,
  handleGeneration: Long,
  batch: String,
  entryCount: Long
): LogAppendResult =
  append(handleId, handleGeneration, batch.toByteArray(Charsets.UTF_8), entryCount)

fun LogFileHandle.appendBatch(batch: String, entryCount: Long): LogAppendResult =
  appendBatch(batch.toByteArray(Charsets.UTF_8), entryCount)

fun FileSinkAnswers.appendBatch(batch: String, entryCount: Double): WireAppendResult =
  appendBatch(batch.toByteArray(Charsets.UTF_8), entryCount)
