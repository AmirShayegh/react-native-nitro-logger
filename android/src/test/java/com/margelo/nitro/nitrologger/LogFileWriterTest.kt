package com.margelo.nitro.nitrologger

import org.junit.After
import org.junit.Assume
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission

/**
 * The Android writer against the same invariants the Swift suite asserts.
 *
 * These run on a plain JVM. That is the payoff for keeping every syscall behind
 * [PlatformIo]: rotation, retention, purge fencing, byte reservation, short
 * writes and crash-tail recovery are all exercised in a second, without an
 * emulator, on the machine that is already running the TypeScript suite.
 */
class LogFileWriterTest {
  private lateinit var directory: File

  /**
   * Injected clock, started at the real one.
   *
   * It has to agree with the filesystem's own timestamps, not float free of
   * them: age-based rotation compares the clock against the file's creation
   * time, which the filesystem stamps and no injection can move. A clock set
   * to a fixed constant in the past makes every file look like it was created
   * in the future.
   */
  private var now = System.currentTimeMillis()

  /**
   * Injected monotonic clock, separate from [now] on purpose.
   *
   * Deadlines and backoff read this one; ages and archive stamps read [now].
   * Keeping them independent is what lets a test move the wall clock backwards
   * — the thing an NTP correction does — and assert that no deadline grew.
   */
  private var steady = 0L
  private val opened = mutableListOf<LogFileWriter>()

  @Before
  fun setUp() {
    now = System.currentTimeMillis()
    steady = 0L
    directory = File.createTempFile("nitro-logger-test", "").let {
      it.delete()
      File(it.absolutePath + "-dir").apply { mkdirs() }
    }
  }

  @After
  fun tearDown() {
    opened.forEach { runCatching { it.close(1, 500.0) } }
    opened.clear()
    directory.deleteRecursively()
  }

  private fun writer(
    name: String = "app.log",
    policy: LogRotationPolicy = LogRotationPolicy.of(),
    lineFramed: Boolean = true,
    platform: PlatformIo = PlatformIo.Jvm,
    rawWrite: LogFileWriter.RawWrite? = null,
    compressor: LogFileWriter.Compressor? = null,
    monotonic: (() -> Long)? = null
  ): LogFileWriter {
    val file = File(directory, name)
    return LogFileWriter.open(
      file = file,
      canonicalPath = file.absolutePath,
      policy = policy,
      lineFramed = lineFramed,
      platform = platform,
      rawWrite = rawWrite,
      compressor = compressor,
      clock = { now },
      monotonic = monotonic ?: { steady }
    ).also { opened.add(it) }
  }

  private fun LogFileWriter.write(text: String, entries: Long = 1, handle: Long = 1) =
    append(handle, currentGeneration, text, entries)

  // MARK: - Appending

  @Test
  fun `an accepted batch reaches the file`() {
    val w = writer()
    assertTrue(w.write("hello\n").accepted)
    w.flush(1, 1000.0)
    assertEquals("hello\n", File(directory, "app.log").readText())
  }

  @Test
  fun `an empty batch is accepted without being written`() {
    val w = writer()
    val result = w.append(1, w.currentGeneration, "", 0)
    assertTrue(result.accepted)
    assertNull(result.rejectReason)
  }

  // An entry count that disagrees with the payload makes every loss number
  // downstream a guess.
  @Test
  fun `a batch whose entry count contradicts its payload is refused`() {
    val w = writer()
    assertEquals(LogRejectReason.FAILED, w.append(1, w.currentGeneration, "x", 0).rejectReason)
    assertEquals(LogRejectReason.FAILED, w.append(1, w.currentGeneration, "", 3).rejectReason)
    assertEquals(LogRejectReason.FAILED, w.append(1, w.currentGeneration, "x", -1).rejectReason)
  }

  // The cap is on bytes in flight, not bytes enqueued: two batches that each
  // fit but do not fit together cannot both be accepted.
  @Test
  fun `the byte reservation holds while the writer is stalled`() {
    val w = writer()
    val resume = w.stallForTesting()
    try {
      val chunk = "x".repeat(600_000) + "\n"
      assertTrue(w.write(chunk).accepted)
      val second = w.write(chunk)
      assertFalse(second.accepted)
      assertEquals(LogRejectReason.FULL, second.rejectReason)
    } finally {
      resume()
    }
  }

  // The JavaScript backpressure loop polls status exactly when the writer is
  // stalled, so status must not queue behind the write.
  @Test
  fun `status answers while the writer is stalled`() {
    val w = writer()
    val resume = w.stallForTesting()
    try {
      w.write("pending\n")
      val status = w.status(1)
      assertEquals(8L, status.queuedBytes)
    } finally {
      resume()
    }
  }

  // MARK: - Write integrity

  // A half-written batch is a half-written record, and that makes the rest of
  // the file unparseable from that point on.
  @Test
  fun `a failed write is rolled back to the record boundary`() {
    var failNext = false
    val w = writer(rawWrite = { stream, data, offset, length ->
      if (failNext) {
        // Land half of it, then fail: the case a naive writer treats as done.
        stream.write(data, offset, length / 2)
        throw java.io.IOException("injected")
      }
      stream.write(data, offset, length)
      length
    })

    w.write("first\n")
    w.flush(1, 1000.0)
    failNext = true
    w.write("second-and-then-some\n")
    w.flush(1, 1000.0)

    assertEquals("first\n", File(directory, "app.log").readText())
  }

  @Test
  fun `a failed write is counted lost against its own handle`() {
    val w = writer(rawWrite = { _, _, _, _ -> throw java.io.IOException("injected") })
    w.write("gone\n", entries = 4, handle = 7)
    w.flush(7, 1000.0)

    assertEquals(4L, w.status(7).lostEntries)
    // Loss is per handle: another handle's numbers are untouched.
    assertEquals(0L, w.status(9).lostEntries)
  }

  // `write(2)` may write less than asked. Treating that as success is how a
  // record loses its second half.
  @Test
  fun `a short write is retried to completion`() {
    var chunks = 0
    val w = writer(rawWrite = { stream, data, offset, length ->
      chunks += 1
      val take = minOf(length, 3)
      stream.write(data, offset, take)
      take
    })
    w.write("abcdefghij\n")
    w.flush(1, 1000.0)

    assertEquals("abcdefghij\n", File(directory, "app.log").readText())
    assertTrue("expected several short writes, saw $chunks", chunks > 1)
  }

  // MARK: - Crash-tail recovery

  @Test
  fun `a torn trailing record is trimmed under a framing contract`() {
    File(directory, "app.log").writeText("good\ntorn-half")
    val w = writer(lineFramed = true)
    w.settleForTesting()
    assertEquals("good\n", File(directory, "app.log").readText())
  }

  // Without the declaration the trailing bytes are indistinguishable from a
  // record that simply contains newlines.
  @Test
  fun `a torn trailing record is left alone without a framing contract`() {
    File(directory, "app.log").writeText("good\ntorn-half")
    val w = writer(lineFramed = false)
    w.settleForTesting()
    assertEquals("good\ntorn-half", File(directory, "app.log").readText())
  }

  @Test
  fun `a file that is one incomplete record is emptied`() {
    File(directory, "app.log").writeText("no newline at all")
    val w = writer(lineFramed = true)
    w.settleForTesting()
    assertEquals("", File(directory, "app.log").readText())
  }

  @Test
  fun `a file already on a record boundary is untouched`() {
    File(directory, "app.log").writeText("complete\n")
    val w = writer(lineFramed = true)
    w.settleForTesting()
    assertEquals("complete\n", File(directory, "app.log").readText())
  }

  // MARK: - Rotation

  @Test
  fun `the file rotates once it passes its size limit`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 32.0))
    repeat(6) { w.write("0123456789\n") }
    w.flush(1, 1000.0)
    w.settleForTesting()

    val archives = directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }
    assertTrue("expected an archive, saw ${directory.list()!!.toList()}", archives.isNotEmpty())
  }

  @Test
  fun `age rotates the file even when it is small`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileAgeSeconds = 60.0))
    w.write("early\n")
    w.flush(1, 1000.0)

    now += 61_000
    w.write("late\n")
    w.flush(1, 1000.0)
    w.settleForTesting()

    val archives = directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }
    assertEquals(1, archives.size)
  }

  @Test
  fun `archives are pruned to the count cap`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0, maxArchivedFilesCount = 2.0))
    repeat(10) {
      w.write("0123456789012345\n")
      now += 1_000
    }
    w.flush(1, 1000.0)
    w.settleForTesting()

    val archives = directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }
    assertTrue("expected at most 2 archives, saw ${archives.size}", archives.size <= 2)
  }

  @Test
  fun `archives older than the age cap are swept`() {
    val w = writer(
      policy = LogRotationPolicy.of(
        maxFileSizeBytes = 16.0,
        maxArchivedFilesCount = 50.0,
        maxArchiveAgeSeconds = 30.0
      )
    )
    w.write("0123456789012345\n")
    w.flush(1, 1000.0)
    w.settleForTesting()

    val firstRound = directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }
    assertTrue(firstRound.isNotEmpty())
    // Age the archive past the cap by its modification time, which is what the
    // sweep actually reads.
    firstRound.forEach { File(directory, it).setLastModified(now - 120_000) }

    now += 1_000
    w.write("0123456789012345\n")
    w.flush(1, 1000.0)
    w.settleForTesting()

    val survivors = directory.list()!!
      .filter { LogFileWriter.isArchiveName(it, "app.log") }
      .filter { it in firstRound }
    assertTrue("an expired archive survived: $survivors", survivors.isEmpty())
  }

  @Test
  fun `compression replaces the archive and leaves no plaintext behind`() {
    val w = writer(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0, compressArchives = true)
    )
    repeat(3) {
      w.write("0123456789012345\n")
      now += 1_000
    }
    w.flush(1, 1000.0)
    w.settleForTesting()

    val names = directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }
    assertTrue("expected archives, saw ${directory.list()!!.toList()}", names.isNotEmpty())
    assertTrue("expected every archive gzipped, saw $names", names.all { it.endsWith(".gz") })
  }

  // A bigger archive beats a lost one.
  @Test
  fun `a failed compression keeps the plaintext archive and records it`() {
    val w = writer(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0, compressArchives = true),
      compressor = { _, _ -> false }
    )
    repeat(2) {
      w.write("0123456789012345\n")
      now += 1_000
    }
    w.flush(1, 1000.0)
    w.settleForTesting()

    val names = directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }
    assertTrue("expected a surviving plaintext archive", names.any { !it.endsWith(".gz") })
    assertTrue(w.status(1).degraded and LogDegradation.GZIP != 0)
  }

  // An interrupted compression must not leave something that looks like a
  // finished archive, nor occupy a retention slot.
  @Test
  fun `an orphaned staging file is not an archive and is swept`() {
    val orphan = File(directory, "app.log.20240101T000000Z_abcdef01.gz.part")
    orphan.writeText("interrupted")
    assertFalse(LogFileWriter.isArchiveName(orphan.name, "app.log"))
    assertTrue(LogFileWriter.isStagingName(orphan.name, "app.log"))

    val w = writer()
    w.settleForTesting()
    assertFalse("the staging orphan survived open", orphan.exists())
  }

  // A rotation that fails on every write turns a degraded log into a busy one.
  @Test
  fun `a failed rotation backs off instead of retrying every write`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 8.0))
    w.settleForTesting()

    // Make the rename fail by putting a non-empty directory where the archive
    // would land is impractical; instead delete the parent's write permission.
    directory.setWritable(false, false)
    try {
      repeat(5) { w.write("0123456789\n") }
      w.flush(1, 1000.0)
      w.settleForTesting()
      val attempts = w.rotationAttemptsForTesting
      assertTrue("expected the backoff to bound retries, saw $attempts", attempts <= 2)
    } finally {
      directory.setWritable(true, true)
    }
  }

  // MARK: - Purge

  @Test
  fun `a purge deletes every artifact and lets the writer resume`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0))
    repeat(4) {
      w.write("0123456789012345\n")
      now += 1_000
    }
    w.flush(1, 1000.0)
    w.settleForTesting()
    assertTrue(directory.list()!!.isNotEmpty())

    val (outcome, generation) = w.clearLogs(2000.0)
    assertTrue(outcome.durable)
    assertTrue(outcome.rebound)
    assertTrue(outcome.failedPaths.isEmpty())

    // Every archive is gone, and the file the writer rebound to is empty. A
    // durable purge that reopens leaves a fresh zero-length `app.log` behind —
    // that is the writer working, not a survivor.
    val survivors = directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }
    assertTrue("archives survived the purge: $survivors", survivors.isEmpty())
    assertEquals(0L, File(directory, "app.log").length())

    assertTrue(w.append(1, generation, "after\n", 1).accepted)
    w.flush(1, 1000.0)
    assertEquals("after\n", File(directory, "app.log").readText())
  }

  // Writing pre-purge data into the fresh file would resurrect exactly what the
  // user asked to be deleted.
  @Test
  fun `a handle that has not rebound is fenced after a purge`() {
    val w = writer()
    val stale = w.currentGeneration
    w.write("before\n")
    w.flush(1, 1000.0)

    w.clearLogs(2000.0)

    val result = w.append(1, stale, "smuggled\n", 1)
    assertFalse(result.accepted)
    assertEquals(LogRejectReason.STALE_GENERATION, result.rejectReason)
  }

  // Bytes accepted before the purge and still in flight must be dropped
  // silently — reporting them would describe a gap the user asked for.
  @Test
  fun `in-flight bytes from before a purge are dropped without being counted lost`() {
    val w = writer()
    val generation = w.currentGeneration
    val resume = w.stallForTesting()
    w.append(1, generation, "in-flight\n", 1)
    resume()

    w.clearLogs(2000.0)
    w.settleForTesting()

    assertEquals(0L, w.status(1).lostEntries)
  }

  @Test
  fun `a purge sweeps the sidecar and every staging file`() {
    File(directory, "app.log.meta").writeText("1700000000000")
    File(directory, "app.log.20240101T000000Z_abcdef01").writeText("archive")
    File(directory, "app.log.20240101T000000Z_abcdef02.gz").writeText("gz")
    File(directory, "app.log.20240101T000000Z_abcdef03.gz.part").writeText("part")
    File(directory, "unrelated.txt").writeText("not ours")

    val w = writer()
    val (outcome, _) = w.clearLogs(2000.0)

    assertTrue(outcome.durable)
    // Everything named above is gone. Asserted by name rather than by listing
    // the directory, because a durable purge reopens the log file and may
    // rewrite the sidecar behind it — both of which are the writer working,
    // not artifacts that survived.
    assertFalse(File(directory, "app.log.20240101T000000Z_abcdef01").exists())
    assertFalse(File(directory, "app.log.20240101T000000Z_abcdef02.gz").exists())
    assertFalse(File(directory, "app.log.20240101T000000Z_abcdef03.gz.part").exists())
    // Anything that is not ours is left strictly alone.
    assertTrue(File(directory, "unrelated.txt").exists())
  }

  // The worst possible lie for this particular call to tell.
  @Test
  fun `a purge that cannot read the directory does not claim to be durable`() {
    val w = writer()
    w.settleForTesting()
    directory.setReadable(false, false)
    directory.setExecutable(false, false)
    try {
      val (outcome, _) = w.clearLogs(2000.0)
      if (directory.list() == null) {
        assertFalse("an unreadable directory reported a durable purge", outcome.durable)
      }
    } finally {
      directory.setReadable(true, true)
      directory.setExecutable(true, true)
    }
  }

  // MARK: - Liveness

  // Writes to an unlinked file succeed forever and land nowhere.
  @Test
  fun `an externally deleted file is reopened rather than written into the void`() {
    var links = 1
    val platform = object : PlatformIo by PlatformIo.Jvm {
      override fun linkCount(descriptor: java.io.FileDescriptor) = links
    }
    val w = writer(platform = platform)
    w.write("before\n")
    w.flush(1, 1000.0)

    File(directory, "app.log").delete()
    links = 0
    // The health check runs on a stride, so drive it past one.
    repeat(LogFileWriterConstants.HEALTH_CHECK_STRIDE + 1) { w.write("after\n") }
    w.flush(1, 1000.0)
    w.settleForTesting()

    assertTrue("the writer never reopened", File(directory, "app.log").exists())
  }

  /**
   * Arms the reopen backoff by making one reopen genuinely fail.
   *
   * The log directory is deleted and its *parent* made unwritable, because
   * `reopen` re-creates the log directory itself — making that one unwritable
   * only has `restrictToOwner` hand the permission straight back. Returns the
   * log directory, with the parent writable again: the writer is now inside a
   * backoff window whose obstacle is gone.
   */
  private fun armReopenBackoff(w: LogFileWriter, logs: File) {
    w.closeStreamForTesting()
    assertTrue(logs.deleteRecursively())
    assertTrue(directory.setWritable(false, false))
    w.write("blocked\n")
    w.settleForTesting()
    assertFalse("precondition: the reopen has to have failed", logs.exists())
    assertTrue(directory.setWritable(true, true))
  }

  /**
   * A flush is a caller saying "put what is buffered on storage now", and the
   * answer must not be "not for another second". Without the bypass a writer
   * that lost its stream inside the backoff window reports a failed flush and
   * reopens nothing, so the retry the caller is told to make fails identically
   * — which on the process-death path loses the records explaining the
   * shutdown.
   */
  @Test
  fun `a flush reopens a stream lost inside the backoff window`() {
    val logs = File(directory, "sub")
    val w = writer(name = "sub/app.log")
    armReopenBackoff(w, logs)

    // `steady` has not moved, so the writer is still inside its backoff window.
    val outcome = w.flush(1, 1000.0)

    assertTrue("a flush must ignore the reopen backoff", outcome.durable)
    assertTrue(File(logs, "app.log").exists())
  }

  /**
   * The other direction, and the reason the bypass is a parameter rather than
   * the new default: an ordinary write inside the window must still be refused,
   * or a writer on a read-only volume retries the open on every single batch.
   */
  @Test
  fun `an ordinary write still honours the backoff window`() {
    val logs = File(directory, "sub")
    val w = writer(name = "sub/app.log")
    armReopenBackoff(w, logs)

    w.write("still inside the window\n")
    w.settleForTesting()
    assertFalse("a plain write must not bypass the backoff", logs.exists())

    steady += LogFileWriterConstants.REOPEN_BACKOFF_MS
    w.write("window elapsed\n")
    w.settleForTesting()
    assertTrue("once the window passes the write reopens", File(logs, "app.log").exists())
  }

  /** A flush that reopens and still cannot write reports the truth. */
  @Test
  fun `a writer that cannot reopen reports a flush that is not durable`() {
    val logs = File(directory, "sub")
    val w = writer(name = "sub/app.log")
    w.closeStreamForTesting()
    assertTrue(logs.deleteRecursively())
    assertTrue(directory.setWritable(false, false))
    try {
      assertFalse(w.flush(1, 500.0).durable)
    } finally {
      directory.setWritable(true, true)
    }
  }

  // MARK: - Deadlines

  @Test
  fun `a stalled writer times out rather than blocking forever`() {
    val w = writer()
    val resume = w.stallForTesting()
    try {
      val started = System.currentTimeMillis()
      val outcome = w.flush(1, 150.0)
      val elapsed = System.currentTimeMillis() - started
      assertTrue(outcome.timedOut)
      assertFalse(outcome.durable)
      assertTrue("waited $elapsed ms for a 150 ms budget", elapsed < 2_000)
    } finally {
      resume()
    }
  }

  @Test
  fun `deadline clamping treats infinity as the ceiling and NaN as no wait`() {
    assertEquals(LogFileWriter.MAX_DEADLINE_MS, LogFileWriter.clampDeadline(Double.POSITIVE_INFINITY))
    assertEquals(0L, LogFileWriter.clampDeadline(Double.NaN))
    assertEquals(0L, LogFileWriter.clampDeadline(-5.0))
    assertEquals(250L, LogFileWriter.clampDeadline(250.0))
    assertEquals(LogFileWriter.MAX_DEADLINE_MS, LogFileWriter.clampDeadline(1e9))
  }

  // MARK: - Naming scheme

  @Test
  fun `the artifact predicate covers everything rotation can produce`() {
    val base = "app.log"
    assertTrue(LogFileWriter.isArtifactName("app.log", base))
    assertTrue(LogFileWriter.isArtifactName("app.log.meta", base))
    assertTrue(LogFileWriter.isArtifactName("app.log.20240101T000000Z_abcdef01", base))
    assertTrue(LogFileWriter.isArtifactName("app.log.20240101T000000Z_abcdef01.gz", base))
    assertTrue(LogFileWriter.isArtifactName("app.log.20240101T000000Z_abcdef01.gz.part", base))

    assertFalse(LogFileWriter.isArtifactName("app.log.txt", base))
    assertFalse(LogFileWriter.isArtifactName("other.log", base))
    assertFalse(LogFileWriter.isArtifactName("app.log.20240101T000000Z_ABCDEF01", base))
    assertFalse(LogFileWriter.isArtifactName("app.log.notatimestamp", base))
  }

  // MARK: - Secure creation

  /**
   * The actual mode bits, not `canRead()`.
   *
   * `canRead`/`canWrite` answer for the *current user*, so they are true of a
   * world-readable file and of an owner-only one alike — an assertion that
   * cannot fail is not a test, and this one used to end at `assertNotNull`.
   *
   * `java.nio.file` is API 26 and this library supports 24, which is why the
   * shipped writer does not use it. That constraint does not reach the test
   * source set: these run on a desktop JVM, and reading the mode is the only
   * way to know the writer applied it.
   */
  private fun mode(file: File): Set<PosixFilePermission> =
    Files.getPosixFilePermissions(file.toPath())

  private val ownerOnlyDirectory = setOf(
    PosixFilePermission.OWNER_READ,
    PosixFilePermission.OWNER_WRITE,
    PosixFilePermission.OWNER_EXECUTE
  )

  private val ownerOnlyFile = setOf(
    PosixFilePermission.OWNER_READ,
    PosixFilePermission.OWNER_WRITE
  )

  @Test
  fun `the log directory and file are restricted to their owner`() {
    val w = writer(name = "sub/app.log")
    w.write("x\n")
    w.flush(1, 500.0)
    val logs = File(directory, "sub")

    assertEquals(ownerOnlyDirectory, mode(logs))
    assertEquals(ownerOnlyFile, mode(File(logs, "app.log")))
  }

  /**
   * A directory needs the execute bit or nothing inside it can be reached by
   * path; a file must not have it. `0700` on a file is the kind of thing that
   * gets copied into the next project.
   */
  @Test
  fun `the log file does not get the directory's execute bit`() {
    val w = writer()
    w.write("x\n")
    w.flush(1, 500.0)

    assertFalse(PosixFilePermission.OWNER_EXECUTE in mode(File(directory, "app.log")))
  }

  /**
   * An archive that inherits default permissions is exactly as readable as the
   * log it was rotated from, so rotation is the interesting case, not creation.
   */
  @Test
  fun `every rotation artifact is restricted to its owner`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 64.0))
    repeat(6) { w.write("x".repeat(40) + "\n") }
    w.flush(1, 1000.0)
    w.settleForTesting()

    val artifacts = directory.listFiles()!!.filter { it.isFile }
    assertTrue("nothing rotated, so this asserted nothing", artifacts.size > 1)
    for (artifact in artifacts) {
      assertEquals("$artifact is readable by more than its owner",
                   ownerOnlyFile, mode(artifact))
    }
  }

  /** Compression stages through a `.part` file, which is just as sensitive. */
  @Test
  fun `a gzipped archive is restricted to its owner`() {
    val w = writer(policy = LogRotationPolicy.of(
      maxFileSizeBytes = 64.0, compressArchives = true))
    repeat(6) { w.write("x".repeat(40) + "\n") }
    w.flush(1, 1000.0)
    w.settleForTesting()

    val gzipped = directory.listFiles()!!.filter { it.name.endsWith(".gz") }
    assertTrue("nothing compressed, so this asserted nothing", gzipped.isNotEmpty())
    for (archive in gzipped) assertEquals(ownerOnlyFile, mode(archive))
  }

  /**
   * A file recreated after an external delete must not come back looser.
   *
   * The injected link count is what makes the reopen happen at all: the JVM
   * `PlatformIo` answers `-1` — "cannot say" — and the writer treats that as
   * no evidence of deletion rather than as deletion.
   */
  @Test
  fun `a recreated log file is restricted to its owner`() {
    var links = 1
    val w = writer(platform = object : PlatformIo by PlatformIo.Jvm {
      override fun linkCount(descriptor: java.io.FileDescriptor) = links
    })
    w.write("before\n")
    w.flush(1, 500.0)
    assertTrue(File(directory, "app.log").delete())
    links = 0

    repeat(LogFileWriterConstants.HEALTH_CHECK_STRIDE + 1) { w.write("after\n") }
    w.flush(1, 500.0)
    w.settleForTesting()

    assertEquals(ownerOnlyFile, mode(File(directory, "app.log")))
  }

  /**
   * `noBackupFilesDir` is the other half of the at-rest story and is asserted
   * nowhere here on purpose: it comes from `HybridFileSink.defaultLogDirectory`
   * via an Android `Context`, which does not exist under JUnit. It is covered
   * by the on-device pass, not by a stub that would only restate the source.
   */
  @Test
  fun `the writer reports rather than repairs a directory it cannot secure`() {
    val w = writer(platform = object : PlatformIo by PlatformIo.Jvm {
      override fun restrictToOwner(file: File, isDirectory: Boolean) = false
    })
    w.write("x\n")
    w.flush(1, 500.0)

    assertTrue(w.status(1).degraded and LogDegradation.PROTECTION != 0)
  }

  // MARK: - Degradation is reported, not guessed at
  //
  // `degraded` is the only channel the app has for "logging is still happening
  // but not the way you configured it". A bit that is never set is a promise
  // the writer silently stops keeping — so each one gets a test that produces
  // the real failure rather than asserting the constant exists.

  /**
   * A rotation that cannot rename has to say so. Until this, only GZIP was
   * asserted anywhere, and ROTATION, PRUNE and SIDECAR could all have been
   * dead code.
   */
  @Test
  fun `a rotation that cannot rename is recorded`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0))
    w.write("before\n")
    w.flush(1, 500.0)
    w.settleForTesting()

    // Rename needs write permission on the directory; the file itself is
    // already open and keeps being writable through its descriptor.
    assertTrue(directory.setWritable(false, false))
    try {
      w.write("0123456789012345\n")
      w.flush(1, 1000.0)
      w.settleForTesting()

      assertTrue("a failed rotation went unreported",
                 w.status(1).degraded and LogDegradation.ROTATION != 0)
    } finally {
      directory.setWritable(true, true)
    }
  }

  /**
   * An unreadable directory is not an empty one. A sweep that quietly did
   * nothing would let retention drift with no word to the app — which for a
   * package whose retention limit is a compliance control is the failure that
   * matters most here.
   */
  @Test
  fun `a retention sweep that cannot list the directory is recorded`() {
    val w = writer(policy = LogRotationPolicy.of(
      maxFileSizeBytes = 16.0, maxArchivedFilesCount = 1.0))
    w.write("before\n")
    w.flush(1, 500.0)
    w.settleForTesting()

    // Readable off, writable on: the rename still works, the listing does not.
    assertTrue(directory.setReadable(false, false))
    try {
      // Probed HERE, not after the writes. A rotation ends in `reopen`, which
      // re-secures the directory and hands the read bit straight back — so a
      // check afterwards always finds it readable, and the precondition would
      // read as unmet on every run. The only honest moment to ask is while the
      // permission is off.
      //
      // `assumeTrue`, not an `if`: a root JVM can list a mode-0300 directory,
      // and there is then no failure for the writer to report. That is an
      // environment this invariant cannot be exercised in, and it should say
      // so — a silent pass claims coverage the run did not have.
      Assume.assumeTrue("this runtime can list a mode-0300 directory",
                        directory.list() == null)

      w.write("0123456789012345\n")
      w.flush(1, 1000.0)
      w.settleForTesting()

      assertTrue("a sweep that could not list went unreported",
                 w.status(1).degraded and LogDegradation.PRUNE != 0)
    } finally {
      directory.setReadable(true, true)
    }
  }

  /**
   * Losing the sidecar does not break the writer, it breaks *age-based
   * rotation* — the clock restarts on every open, so a file configured to
   * rotate daily may never rotate at all. Degraded, not broken, and therefore
   * exactly the kind of thing the bitmask exists to carry.
   */
  @Test
  fun `a sidecar that cannot be written is recorded`() {
    // A directory where the sidecar file belongs: `writeText` cannot open it,
    // whatever the permissions say, and unlike a mode this cannot be undone by
    // the writer re-securing its own directory.
    assertTrue(File(directory, "app.log.meta").mkdir())

    val w = writer(policy = LogRotationPolicy.of(maxFileAgeSeconds = 60.0))
    w.write("x\n")
    w.flush(1, 500.0)
    w.settleForTesting()

    assertTrue("a sidecar that could not be written went unreported",
               w.status(1).degraded and LogDegradation.SIDECAR != 0)
  }

  // MARK: - Config clamping

  /// The distinction the retention limit has to make: zero is an instruction
  /// and `NaN` is not. Both used to clamp to zero, which meant one malformed
  /// number from JavaScript deleted every rotated file on the next sweep.
  @Test
  fun `an explicit zero keeps no archives but NaN does not`() {
    assertEquals(0, LogRotationPolicy.of(maxArchivedFilesCount = 0.0).maxArchivedFilesCount)
    assertEquals(5, LogRotationPolicy.of(maxArchivedFilesCount = Double.NaN).maxArchivedFilesCount)
    assertEquals(5, LogRotationPolicy.of(maxArchivedFilesCount = -5.0).maxArchivedFilesCount)
    assertEquals(
      10_000,
      LogRotationPolicy.of(maxArchivedFilesCount = Double.POSITIVE_INFINITY).maxArchivedFilesCount
    )
    assertEquals(
      5,
      LogRotationPolicy.of(maxArchivedFilesCount = Double.NEGATIVE_INFINITY).maxArchivedFilesCount
    )
  }

  /// A malformed count must not become a deletion order. This is the clamping
  /// bug with its consequence attached: five archives on disk, one `NaN` from
  /// JavaScript, and a sweep that would have removed all of them.
  @Test
  fun `a malformed archive count does not delete the archives`() {
    val w = writer(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0, maxArchivedFilesCount = Double.NaN)
    )
    repeat(4) {
      w.write("0123456789012345\n")
      now += 1_000
    }
    w.flush(1, 1000.0)
    w.settleForTesting()

    val archives = directory.list()!!.count { LogFileWriter.isArchiveName(it, "app.log") }
    assertTrue("expected the default retention to keep archives, saw $archives", archives > 0)
  }

  // MARK: - Platform seam

  /// The writer must survive a [PlatformIo] that reaches for a class its API
  /// level does not have.
  ///
  /// `NoClassDefFoundError` is an `Error`, not an `Exception`, so a
  /// `catch (Exception)` around the creation-time probe would let it out and
  /// take the open down with it — on exactly the old devices the sidecar exists
  /// to serve.
  @Test
  fun `a platform that throws a linkage error still opens and dates the file`() {
    val hostile = object : PlatformIo by PlatformIo.Jvm {
      override fun creationTimeMillis(file: File): Long? =
        throw NoClassDefFoundError("java/nio/file/Files")
    }
    val w = writer(platform = hostile)
    w.settleForTesting()
    assertTrue(w.write("hello\n").accepted)
    w.flush(1, 1000.0)

    assertEquals("hello\n", File(directory, "app.log").readText())
    assertEquals(now.toString(), File(directory, "app.log.meta").readText().trim())
  }

  /// The sidecar is authoritative once written, and the filesystem is only ever
  /// consulted to seed it.
  ///
  /// Several Android filesystems have no birth time and report the mtime
  /// instead, which advances on every write. Reading it first — as this did —
  /// makes the active file look freshly created at every restart, and age-based
  /// rotation never fires again.
  @Test
  fun `a filesystem that reports the mtime as creation time cannot defeat age rotation`() {
    val mtimeAsCreation = object : PlatformIo by PlatformIo.Jvm {
      // Always "just now", the way an mtime looks after a write.
      override fun creationTimeMillis(file: File): Long? = now
    }

    // A previous run recorded the real creation time an hour ago.
    File(directory, "app.log.meta").writeText((now - 3_600_000).toString())

    val w = writer(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 1e9, maxFileAgeSeconds = 60.0),
      platform = mtimeAsCreation
    )
    w.write("late\n")
    w.flush(1, 1000.0)
    w.settleForTesting()

    val archives = directory.list()!!.count { LogFileWriter.isArchiveName(it, "app.log") }
    assertEquals("the sidecar's age should have rotated the file", 1, archives)
  }

  /// A sidecar from the future must not silence age rotation.
  ///
  /// Making the sidecar authoritative created this: a value ahead of the clock
  /// — a corrupt file, or one written before the device's time was corrected
  /// backwards — makes `now - start` negative, which reads as "not old yet" and
  /// postpones rotation until wall time catches up.
  @Test
  fun `a sidecar dated in the future is rewritten rather than obeyed`() {
    File(directory, "app.log.meta").writeText((now + 86_400_000).toString())

    val w = writer(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 1e9, maxFileAgeSeconds = 60.0)
    )
    w.settleForTesting()

    // Rewritten to something the clock has already reached. Not asserted equal
    // to `now`: a plausible filesystem creation time is allowed to win the seed,
    // and on a one-second-granularity filesystem that is a little earlier.
    val rewritten = File(directory, "app.log.meta").readText().trim().toLong()
    assertTrue("the sidecar is still in the future: $rewritten vs $now", rewritten <= now)

    // And with a sane start time, age rotation still works.
    now += 61_000
    w.write("late\n")
    w.flush(1, 1000.0)
    w.settleForTesting()
    assertEquals(1, directory.list()!!.count { LogFileWriter.isArchiveName(it, "app.log") })
  }

  /// After a rotation the fresh file must be dated fresh — even if the sidecar
  /// could not be updated.
  ///
  /// Deleting the sidecar was the obvious move and the wrong one once it became
  /// authoritative: a deletion that fails leaves the archived file's age in
  /// charge of the brand new file, which then rotates on every single write and
  /// prunes real archives in favour of empty ones.
  @Test
  fun `a rotation dates the fresh file even when the sidecar cannot be updated`() {
    val w = writer(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 1e9, maxFileAgeSeconds = 60.0)
    )
    w.settleForTesting()

    now += 61_000
    w.write("rotate me\n")
    w.flush(1, 1000.0)
    w.settleForTesting()
    assertEquals(1, directory.list()!!.count { LogFileWriter.isArchiveName(it, "app.log") })

    // The fresh file is young now, so more writes must not rotate it again.
    repeat(5) { w.write("still young\n") }
    w.flush(1, 1000.0)
    w.settleForTesting()
    assertEquals(
      "the fresh file inherited the archived file's age",
      1,
      directory.list()!!.count { LogFileWriter.isArchiveName(it, "app.log") }
    )
  }

  /// The fresh age survives a sidecar write that fails *and* a reopen that
  /// fails after it.
  ///
  /// Carrying the rotation's timestamp into one `reopen` call was not enough:
  /// if that reopen also failed, the next backoff retry went back through the
  /// sidecar — which still held the archived file's age — and the
  /// rotate-on-every-write runaway resumed. The value has to outrank the
  /// sidecar until it is actually on disk, however many failed opens that takes.
  @Test
  fun `a rotation keeps the fresh age across a failed sidecar write and a failed reopen`() {
    // The platform refuses to open `app.log` while this is set, which is how
    // the post-rotation reopen is made to fail on demand.
    var refuseOpen = false
    val platform = object : PlatformIo by PlatformIo.Jvm {
      override fun isSymbolicLink(file: File): Boolean =
        if (refuseOpen && file.name == "app.log") true
        else PlatformIo.Jvm.isSymbolicLink(file)
    }

    // A previous run left the file an hour old, so the first write rotates.
    val sidecar = File(directory, "app.log.meta")
    sidecar.writeText((now - 3_600_000).toString())

    val w = writer(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 1e9, maxFileAgeSeconds = 60.0),
      platform = platform
    )
    w.settleForTesting()

    // Read-only, so every attempt to record the fresh time fails.
    assertTrue(sidecar.setWritable(false, false))
    refuseOpen = true

    w.write("rotate me\n")
    w.settleForTesting()
    assertEquals(1, directory.list()!!.count { LogFileWriter.isArchiveName(it, "app.log") })
    assertFalse("the reopen was supposed to fail", w.hasLiveStreamForTesting)
    assertEquals(
      "the stale sidecar should not have been overwritten",
      (now - 3_600_000).toString(),
      sidecar.readText().trim()
    )

    // Let the file open again, past the reopen backoff.
    refuseOpen = false
    steady += 5_000

    repeat(4) { w.write("still young\n") }
    w.flush(1, 1000.0)
    w.settleForTesting()

    assertTrue("expected the writer to have recovered", w.hasLiveStreamForTesting)
    assertEquals(
      "the reopened file inherited the archived file's age from the stale sidecar",
      1,
      directory.list()!!.count { LogFileWriter.isArchiveName(it, "app.log") }
    )
  }

  /// A purge may only count an artifact as gone when the platform says it is —
  /// and the platform, not `File.exists()`, is what it asks.
  ///
  /// `exists()` returns false for "not there" and for "could not tell" alike,
  /// so a purge built on it reports `durable = true` over files still sitting on
  /// disk. For this particular call that is the worst available lie.
  ///
  /// Both halves run the identical scenario — a failed `delete()` over a file
  /// that demonstrably still exists — and differ only in what the platform says
  /// about it. That the outcomes differ is the proof that the answer comes from
  /// [PlatformIo.lookup]; an implementation reading `exists()` would fail the
  /// first half, since the file is right there.
  @Test
  fun `the purge takes its proof of absence from the platform`() {
    fun purgeSaying(presence: PlatformIo.Presence): LogClearOutcome {
      val platform = object : PlatformIo by PlatformIo.Jvm {
        override fun lookup(file: File) = presence
      }
      val w = writer(name = "app-$presence.log", platform = platform)
      w.write("hello\n")
      w.flush(1, 1000.0)
      w.settleForTesting()

      val artifact = File(directory, "app-$presence.log")
      assertTrue(artifact.exists())

      // Deletions now fail, so the fallback lookup is what decides.
      directory.setWritable(false, false)
      try {
        val outcome = w.clearLogs(2000.0).first
        assertTrue("the file is still on disk either way", artifact.exists())
        return outcome
      } finally {
        directory.setWritable(true, true)
      }
    }

    val claimedGone = purgeSaying(PlatformIo.Presence.ABSENT)
    assertTrue("the platform said absent, so the purge counts it deleted", claimedGone.durable)
    assertTrue(claimedGone.failedPaths.isEmpty())

    val cannotTell = purgeSaying(PlatformIo.Presence.UNKNOWN)
    assertFalse("an unprovable deletion is not durable", cannotTell.durable)
    assertTrue(cannotTell.failedPaths.isNotEmpty())
  }

  // MARK: - Lifecycle races

  /// A batch accepted just as the executor is torn down must not leak its
  /// reservation.
  ///
  /// The reservation is committed under the state lock and the task submitted
  /// after it is released. A close landing in that window makes `execute` throw:
  /// unhandled, it crosses the bridge, and the bytes stay reserved forever —
  /// `queuedBytes` never returns to zero and the 1 MB cap eventually refuses
  /// everything.
  @Test
  fun `a batch rejected by a dead executor releases its reservation`() {
    val w = writer()
    w.settleForTesting()
    w.shutdownExecutorForTesting()

    val result = w.write("hello\n")
    assertFalse(result.accepted)
    assertEquals(LogRejectReason.CLOSED, result.rejectReason)
    assertEquals("the reservation must not survive the rejection", 0L, w.status(1).queuedBytes)
  }

  /// Deadlines read a monotonic clock, so a wall clock that steps backwards
  /// cannot extend them.
  ///
  /// An NTP correction or a user changing the date moves `currentTimeMillis`;
  /// a close that was promised 200 ms and takes an hour because of it is an ANR.
  @Test
  fun `a wall clock that jumps backwards does not extend a deadline`() {
    val w = writer()
    val resume = w.stallForTesting()
    try {
      now -= 3_600_000 // the wall clock steps back an hour, mid-flight
      val started = System.nanoTime()
      val outcome = w.flush(1, 200.0)
      val elapsedMs = (System.nanoTime() - started) / 1_000_000

      assertTrue(outcome.timedOut)
      assertTrue("the flush ran for ${elapsedMs}ms against a 200ms budget", elapsedMs < 5_000)
    } finally {
      resume()
    }
  }

  /// An interrupted caller gets the documented fallback, not an exception
  /// crossing the bridge — and keeps its interrupt flag.
  ///
  /// `CountDownLatch.await` throws `InterruptedException`, which the bounded
  /// barrier's contract ("timeout or shutdown returns false") did not account
  /// for.
  @Test
  fun `an interrupted log paths call falls back instead of throwing`() {
    val w = writer()
    w.settleForTesting()

    val resume = w.stallForTesting()
    try {
      var paths: List<String>? = null
      var thrown: Throwable? = null
      var stillInterrupted = false

      val caller = Thread {
        Thread.currentThread().interrupt()
        try {
          paths = w.logFilePaths()
        } catch (t: Throwable) {
          thrown = t
        }
        stillInterrupted = Thread.currentThread().isInterrupted
      }
      caller.start()
      caller.join(5_000)

      assertNull("logFilePaths must not throw at an interrupted caller", thrown)
      assertEquals(listOf(File(directory, "app.log").absolutePath), paths)
      assertTrue("the interrupt flag must survive the call", stillInterrupted)
    } finally {
      resume()
    }
  }

  /// `logFilePaths` reads the directory on the executor, so it cannot observe a
  /// rotation or a purge halfway through — and it is bounded, because it is
  /// reachable from the JS thread and the executor may be wedged.
  /// Rotated first, so the two behaviours are distinguishable: an enumeration
  /// done on the caller's thread would still see the archive while the executor
  /// is stalled, and the confined one cannot.
  @Test
  fun `log file paths stay answerable while the writer is stalled`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0))
    repeat(2) {
      w.write("0123456789012345\n")
      now += 1_000
    }
    w.flush(1, 1000.0)
    w.settleForTesting()

    val settled = w.logFilePaths()
    assertTrue(settled.contains(File(directory, "app.log").absolutePath))
    assertTrue("expected a rotation to have produced an archive", settled.size > 1)

    val resume = w.stallForTesting()
    try {
      val started = System.nanoTime()
      val stalled = w.logFilePaths()
      val elapsedMs = (System.nanoTime() - started) / 1_000_000

      // The archive is still on disk; only an executor-confined reader is
      // unable to report it while the executor is wedged.
      assertEquals(listOf(File(directory, "app.log").absolutePath), stalled)
      assertTrue(
        "expected the bounded wait, ran ${elapsedMs}ms",
        elapsedMs < LogFileWriter.PATHS_DEADLINE_MS + 3_000
      )
    } finally {
      resume()
    }
  }
}

/** Mirror of the writer's private stride, so the liveness test can drive past it. */
object LogFileWriterConstants {
  const val HEALTH_CHECK_STRIDE = 8

  /** Mirrors the writer's private `REOPEN_BACKOFF_MS`. */
  const val REOPEN_BACKOFF_MS = 1_000L
}
