package com.margelo.nitro.nitrologger

import org.junit.After
import org.junit.Assume
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.io.FileOutputStream
import java.io.RandomAccessFile
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
   *
   * ## Why atomic
   *
   * The test thread advances it; the **writer thread** reads it, through the
   * `clock` lambda, on every rotation check. A plain `var` is a data race
   * across those two threads with no happens-before edge between them, so
   * nothing obliges the writer to ever see an advance — the JIT is free to
   * hoist the read out of its loop. For 235 short sequential tests that has
   * never visibly bitten, which is exactly why it is worth fixing before
   * `LogBurstTest` runs the executor hot for thousands of records.
   *
   * `AtomicLong` rather than `@Volatile`, because the natural way to write
   * these tests is `+=`, and a volatile read-modify-write is not atomic. Today
   * every advance happens on the test thread, where that would be survivable —
   * but `a failed compression keeps the plaintext archive` already advances the
   * clock a line away from an injected `compressor` lambda that runs on the
   * writer thread, and the day one moves inside is not a day anyone will be
   * looking for it.
   */
  private val now = AtomicLong(System.currentTimeMillis())

  /**
   * Injected monotonic clock, separate from [now] on purpose.
   *
   * Deadlines and backoff read this one; ages and archive stamps read [now].
   * Keeping them independent is what lets a test move the wall clock backwards
   * — the thing an NTP correction does — and assert that no deadline grew.
   *
   * Atomic for the same reason as [now], and read from the same thread.
   */
  private val steady = AtomicLong(0)
  private val opened = mutableListOf<LogFileWriter>()

  @Before
  fun setUp() {
    now.set(System.currentTimeMillis())
    steady.set(0)
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
      clock = { now.get() },
      monotonic = monotonic ?: { steady.get() }
    ).also { opened.add(it) }
  }

  private fun LogFileWriter.write(text: String, entries: Long = 1, handle: Long = 1) =
    append(handle, currentGeneration, text, entries)

  /**
   * Skips rather than fails when the runtime is not bound by the permission
   * the test just removed.
   *
   * Every test below that builds an obstacle out of `setWritable(false)` or
   * `setReadable(false)` needs one of these. A root JVM — a CI container's
   * default user, a rooted device — ignores the mode entirely, so the obstacle
   * is not one and the failure the test exists to observe never happens: the
   * assertion then fails for a reason that says nothing about the writer.
   *
   * `assumeTrue`, not an `if`. A silent pass claims coverage the run did not
   * have, which is the same defect in the other direction. Probed **while the
   * permission is off**, because a `reopen` re-secures the directory and hands
   * the bit straight back, so asking afterwards always finds it restored.
   *
   * And a skip here does not quietly become a green build: `check-test-reports`
   * counts skips as problems ("a skip is a hole, not a pass") and fails the
   * target. So what these guards buy is not permission to pass — it is a red
   * that names the real reason, "this runtime ignores file permissions",
   * instead of an assertion failure that reads as a bug in the writer.
   */
  private fun assumeDirectoryRefusesWrites(target: File = directory) {
    val probe = File(target, ".permission-probe")
    val created = runCatching { probe.createNewFile() }.getOrDefault(false)
    if (created) probe.delete()
    Assume.assumeTrue("this runtime can create files in a mode-0500 directory", !created)
  }

  /** The same, for a directory made unreadable rather than unwritable. */
  private fun assumeDirectoryRefusesListing(target: File = directory) {
    Assume.assumeTrue("this runtime can list a mode-0300 directory", target.list() == null)
  }

  /**
   * The same, for a file. Opened for append and closed without writing: the
   * open IS the permission check, and append mode does not truncate, so the
   * probe cannot alter the bytes the test is about to assert on.
   */
  private fun assumeFileRefusesWrites(target: File) {
    val opened = runCatching { FileOutputStream(target, true).close(); true }
      .getOrDefault(false)
    Assume.assumeTrue("this runtime can write to a mode-0400 file", !opened)
  }

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

  // The tracked counter behind `trackedFileSizeForTesting` is what the size
  // trigger in `rotateIfNeeded` reads, and it is the append path's fallback
  // answer for "where does a failed batch roll back to" when `channel.size()`
  // itself throws. A counter that drifts from the true size rotates at the
  // wrong moment at best and truncates somebody else's bytes at worst — so it
  // is pinned to the file at every moment its value changes hands.
  @Test
  fun `the tracked size agrees with the file through open, append and rotation`() {
    // Opened onto existing bytes, the counter must start at the true size. A
    // writer that assumed zero would place its first record boundary inside
    // the records that were already there.
    File(directory, "app.log").writeText("existing\n")
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 32.0))
    assertEquals(9L, w.trackedFileSizeForTesting)

    w.write("0123456789\n")
    w.flush(1, 1000.0)
    assertEquals(20L, w.trackedFileSizeForTesting)

    // Two more pushes it past 32: rotation archives the file, reopens a fresh
    // one, and the counter must restart from the fresh file's true size.
    repeat(2) { w.write("0123456789\n") }
    w.flush(1, 1000.0)
    w.settleForTesting()

    assertEquals(0L, w.trackedFileSizeForTesting)
    assertEquals(File(directory, "app.log").length(), w.trackedFileSizeForTesting)
  }

  @Test
  fun `the tracked size returns to the record boundary after a rolled-back write`() {
    var failNext = false
    val w = writer(rawWrite = { stream, data, offset, length ->
      if (failNext) {
        stream.write(data, offset, length / 2)
        throw java.io.IOException("injected")
      }
      stream.write(data, offset, length)
      length
    })

    w.write("first\n")
    w.flush(1, 1000.0)
    assertEquals(6L, w.trackedFileSizeForTesting)

    failNext = true
    w.write("second-and-then-some\n")
    w.flush(1, 1000.0)

    // Not `6 + length/2`, and not the optimistic `6 + length` a writer that
    // counts what it tried to write would report: the rollback truncated to
    // the record boundary, and the counter must say so.
    assertEquals(6L, w.trackedFileSizeForTesting)
    assertEquals(6L, File(directory, "app.log").length())
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

    now.addAndGet(61_000)
    w.write("late\n")
    w.flush(1, 1000.0)
    w.settleForTesting()

    val archives = directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }
    assertEquals(1, archives.size)
  }

  @Test
  fun `archives are pruned to the count cap`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0, maxArchivedFilesCount = 2.0))

    // Sampled after every rotation rather than once at the end, and that is
    // the whole point of the shape.
    //
    // The prune runs on each rotation, so a writer that keeps one *fewer*
    // than the cap does not settle — it oscillates: prune to 1, rotate to 2,
    // no prune (2 is not > 2), rotate to 3, prune to 1. A single count taken
    // at the end therefore passes or fails on the parity of the loop, and ten
    // rotations happen to land such a writer on 2. Verified: `take(cap - 1)`
    // survives `assertEquals(2, ...)` after this loop.
    //
    // What is actually promised is that the count reaches the cap and stays
    // there, which no oscillation satisfies.
    val counts = mutableListOf<Int>()
    repeat(10) {
      w.write("0123456789012345\n")
      now.addAndGet(1_000)
      w.flush(1, 1000.0)
      w.settleForTesting()
      counts.add(directory.list()!!.count { LogFileWriter.isArchiveName(it, "app.log") })
    }

    // The first two rotations are still filling up to the cap; from the third
    // on it binds, and every sample after that is the cap exactly.
    assertEquals(listOf(1, 2), counts.take(2))
    assertEquals(List(8) { 2 }, counts.drop(2))
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
    firstRound.forEach { File(directory, it).setLastModified(now.get() - 120_000) }

    now.addAndGet(1_000)
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
      now.addAndGet(1_000)
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
    // The control first, and it is what makes the last line mean anything:
    // `GZIP` is set from eight places in the compression path, so "the bit is
    // up" is a claim about the whole path. The same policy with the real
    // compressor has to leave it down, or the injected failure is not what
    // this test is observing.
    val control = writer(
      name = "control.log",
      policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0, compressArchives = true)
    )
    repeat(2) {
      control.write("0123456789012345\n")
      now.addAndGet(1_000)
    }
    control.flush(1, 1000.0)
    control.settleForTesting()
    assertEquals(
      "compression succeeds here, so the assertion below distinguishes something",
      0,
      control.status(1).degraded and LogDegradation.GZIP
    )

    val w = writer(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0, compressArchives = true),
      compressor = { _, _ -> false }
    )
    repeat(2) {
      w.write("0123456789012345\n")
      now.addAndGet(1_000)
    }
    w.flush(1, 1000.0)
    w.settleForTesting()

    val names = directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }
    assertTrue("expected a surviving plaintext archive", names.any { !it.endsWith(".gz") })
    assertTrue(w.status(1).degraded and LogDegradation.GZIP != 0)
  }

  @Test
  fun `open returns without waiting for the retention sweep`() {
    val held = CountDownLatch(1)
    val inSweep = CountDownLatch(1)
    try {
      releaseAfter(held, 3_000)
      val began = System.nanoTime()
      val w = LogFileWriter.open(
        file = File(directory, "app.log"),
        canonicalPath = File(directory, "app.log").absolutePath,
        policy = LogRotationPolicy.of(),
        lineFramed = true,
        platform = PlatformIo.Jvm,
        clock = { now.get() },
        monotonic = { steady.get() },
        openSweepGate = {
          inSweep.countDown()
          held.await()
        }
      ).also { opened.add(it) }
      val elapsedMs = (System.nanoTime() - began) / 1_000_000

      // The sweep is provably still running — it is sitting in the gate — and
      // `open` has already returned. Before this change it waited.
      assertTrue("the sweep never reached its gate", inSweep.await(10, TimeUnit.SECONDS))
      assertTrue("open waited for the retention sweep", elapsedMs < 2_000)

      // And the writer is usable while the sweep is still gated, which is the
      // point of moving it: the trim that had to finish already has.
      assertTrue(w.append(1, w.currentGeneration, "usable\n", 1).accepted)
    } finally {
      held.countDown()
    }
  }

  /**
   * What the async sweep is actually worth: the registry lock is free while it
   * runs.
   *
   * Waiting for the sweep meant an unbounded, cross-thread wait on directory
   * I/O taken **inside** the registry lock — so opening one file with a large
   * backlog of archives to prune stalled every other file's acquire and
   * release, including a close with a deadline it had promised to keep.
   *
   * The gated acquire runs on its **own thread**, and that is load-bearing
   * rather than tidy. Measuring a second acquire after the first has returned
   * proves nothing about the lock: a first acquire that waited would simply
   * have finished waiting by then. The second acquire has to be attempted while
   * the first is still inside `registry.acquire`, which needs two threads.
   *
   * What this does not prove: that the sweep *completes* before the first
   * append lands. That follows from the executor being single-threaded, which
   * is a construction argument rather than a tested one.
   */
  @Test
  fun `a gated open sweep on one path does not block another path`() {
    val held = CountDownLatch(1)
    val inSweep = CountDownLatch(1)
    val registry = LogWriterRegistry.isolated()
    val slow = AtomicReference<LogFileHandle>()
    val slowThread = Thread {
      slow.set(
        registry.acquire(
          path = File(directory, "slow.log").absolutePath,
          policy = LogRotationPolicy.of(),
          lineFramed = true,
          platform = PlatformIo.Jvm,
          clock = { now.get() },
          openSweepGate = {
            inSweep.countDown()
            held.await()
          }
        )
      )
    }
    try {
      slowThread.start()
      assertTrue("the sweep never reached its gate", inSweep.await(10, TimeUnit.SECONDS))
      // Insurance against the mutation: with the sweep awaited again, the
      // thread above is stuck inside `acquire` holding the lock and would never
      // reach the release below — the suite would hang instead of failing.
      releaseAfter(held, 3_000)

      val began = System.nanoTime()
      val other = registry.acquire(
        path = File(directory, "other.log").absolutePath,
        policy = LogRotationPolicy.of(),
        lineFramed = true,
        platform = PlatformIo.Jvm,
        clock = { now.get() }
      )
      other.close(1000.0)
      val elapsedMs = (System.nanoTime() - began) / 1_000_000

      assertTrue(
        "a gated sweep on one file held the registry lock against another",
        elapsedMs < 2_000
      )
    } finally {
      held.countDown()
      slowThread.join(10_000)
      slow.get()?.let { runCatching { it.close(1000.0) } }
    }
  }

  /**
   * Moving the sweep off the acquiring thread changed an externally visible
   * contract, so the new contract gets pinned rather than left implied.
   *
   * Open used to guarantee the sweep had *finished*. It now guarantees only
   * that it is queued, which means a `getStatus()` taken right after opening
   * can legitimately report the state from before the sweep ran — a caller
   * that opens and immediately checks `degraded` may see a clean status and a
   * degraded one a moment later, with nothing having gone wrong in between.
   * That is worth a test because it is the kind of difference that otherwise
   * gets discovered as a flake in somebody else's suite.
   *
   * The sweep is made to *fail* here, because a sweep that succeeds leaves no
   * mark on the status and the two moments would be indistinguishable.
   *
   * What this does not prove: that the window is short. There is no bound on
   * how long the queued sweep takes to reach the front — that is the cost the
   * change deliberately accepts in exchange for not paying it on the caller's
   * thread.
   */
  @Test
  fun `status right after open can predate the sweep`() {
    val held = CountDownLatch(1)
    val inSweep = CountDownLatch(1)
    try {
      // Insurance against a revert to the inline sweep: that would block the
      // open below on this test's own thread, and the gate would never open.
      releaseAfter(held, 3_000)
      val w = LogFileWriter.open(
        file = File(directory, "app.log"),
        canonicalPath = File(directory, "app.log").absolutePath,
        policy = LogRotationPolicy.of(),
        lineFramed = true,
        platform = PlatformIo.Jvm,
        clock = { now.get() },
        monotonic = { steady.get() },
        openSweepGate = {
          inSweep.countDown()
          held.await()
        }
      ).also { opened.add(it) }

      assertTrue("the sweep never reached its gate", inSweep.await(10, TimeUnit.SECONDS))
      assertEquals(
        "the sweep is still sitting in its gate — it cannot have reported a failure yet",
        0,
        w.status(1).degraded and LogDegradation.PRUNE
      )

      // Break the sweep from outside the gate it is parked in, so the failure
      // is provably one the sweep hit rather than anything the open did.
      directory.setReadable(false, false)
      assumeDirectoryRefusesListing()
      held.countDown()
      w.settleForTesting()

      assertTrue(
        "once the sweep runs, the listing it could not do is on the status",
        w.status(1).degraded and LogDegradation.PRUNE != 0
      )
    } finally {
      held.countDown()
      directory.setReadable(true, false)
    }
  }

  /**
   * The writer thread lowers *its own* priority, and does it on itself.
   *
   * The signature has no thread parameter precisely because the mistake worth
   * preventing is calling it from the wrong one: `Process.setThreadPriority`
   * acts on the caller, so making the request while constructing the executor
   * — which happens on whichever thread opened the sink, in production the
   * JavaScript thread — would deprioritize the app and leave the log writer
   * exactly where it was. Asserting the *name* of the thread it ran on is what
   * catches that; asserting only that it was called does not.
   *
   * ## What this does not prove
   *
   * That anything happened. `PlatformIo.Jvm` is a no-op and this double only
   * records, so what is pinned is that the request is made, from the right
   * thread, exactly once. Whether the OS honours it is not observable from a
   * JVM and is not observable on a device either — `getThreadPriority` reports
   * what was set, not what the scheduler did with it.
   */
  @Test
  fun `the writer thread lowers its own priority`() {
    val recorder = RecordingPriority()
    val w = LogFileWriter.open(
      file = File(directory, "app.log"),
      canonicalPath = File(directory, "app.log").absolutePath,
      policy = LogRotationPolicy.of(),
      lineFramed = true,
      platform = recorder,
      clock = { now.get() },
      monotonic = { steady.get() }
    ).also { opened.add(it) }

    assertTrue(w.append(1, w.currentGeneration, "x\n", 1).accepted)
    w.settleForTesting()

    assertEquals(
      "the priority request was made on the wrong thread",
      listOf("com.nitrologger.filewriter"),
      recorder.threads()
    )
  }

  /**
   * Records where [deprioritizeCurrentThread] was called from, and does the
   * rest of the work the tests already rely on.
   *
   * Delegation rather than a hand-written stub: a stub would have to
   * reimplement every method, and the one it got subtly wrong would be a test
   * failure that says nothing about priority.
   */
  private class RecordingPriority(
    private val inner: PlatformIo = PlatformIo.Jvm
  ) : PlatformIo by inner {
    private val seen = java.util.Collections.synchronizedList(mutableListOf<String>())

    override fun deprioritizeCurrentThread() {
      seen.add(Thread.currentThread().name)
    }

    fun threads(): List<String> = synchronized(seen) { seen.toList() }
  }

  /** Opens [latch] from a daemon thread after [millis]. */
  private fun releaseAfter(latch: CountDownLatch, millis: Long) {
    Thread {
      Thread.sleep(millis)
      latch.countDown()
    }.apply { isDaemon = true }.start()
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
      // Under a root JVM the rename succeeds, every write rotates cleanly, and
      // the count sails past the backoff bound for a reason that is about the
      // runtime rather than the writer.
      assumeDirectoryRefusesWrites()

      repeat(5) { w.write("0123456789\n") }
      w.flush(1, 1000.0)
      w.settleForTesting()

      // Exactly one. An 11-byte record over an 8-byte threshold means the
      // first write already wants to rotate; it fails, which opens the window,
      // and `steady` never advances, so the window absorbs writes two through
      // five. `<= 2` was satisfied by a writer that retried once more than it
      // should — which is precisely the behaviour a backoff exists to prevent,
      // so it was the one value the assertion had to exclude.
      assertEquals(1, w.rotationAttemptsForTesting)
    } finally {
      directory.setWritable(true, true)
    }
  }

  /**
   * The window is a window, not a latch.
   *
   * Its sibling above proves a failed rotation stops retrying. On its own that
   * is also satisfied by a writer that gives up on rotation permanently after
   * one failure — which would leave a log file growing without bound past a
   * transient fault, the opposite of what a backoff is for. What separates the
   * two is whether attempts resume once the window expires, and only a test
   * that moves the clock can ask.
   *
   * Swift has this test; Kotlin had the injected clock and no test using it
   * for rotation. The asymmetry is the reason it is here.
   */
  @Test
  fun `a rotation retries once the backoff window expires`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 8.0))
    w.settleForTesting()

    directory.setWritable(false, false)
    try {
      assumeDirectoryRefusesWrites()

      w.write("0123456789\n")
      w.flush(1, 1000.0)
      w.settleForTesting()
      assertEquals(1, w.rotationAttemptsForTesting)

      // Still inside the window: no further attempt, however many writes.
      repeat(4) { w.write("0123456789\n") }
      w.flush(1, 1000.0)
      w.settleForTesting()
      assertEquals(1, w.rotationAttemptsForTesting)

      // Past it on the only clock the backoff reads. Nothing else changed —
      // the fault is still in force and the file is still over its threshold.
      steady.addAndGet(LogFileWriterConstants.ROTATION_BACKOFF_MS + 1)
      w.write("0123456789\n")
      w.flush(1, 1000.0)
      w.settleForTesting()

      assertEquals(2, w.rotationAttemptsForTesting)
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
      now.addAndGet(1_000)
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

  /**
   * A purge that arrives after the close barrier still deletes.
   *
   * The call is a compliance purge, and the case is ordinary: a destination is
   * disposed and the app then asks for the logs to be erased. Through 0.2.0
   * Android deleted **nothing** here and reported `durable = false` — the
   * executor was shut down, the submission was refused, and the refusal was
   * caught by a blanket `catch (Exception)` that treated "I could not schedule
   * the work" as "the deletion failed". iOS had always behaved as documented,
   * because its block reaches the queue before the barrier rather than being
   * refused by it, so the two platforms disagreed about the one call where
   * disagreeing matters most.
   *
   * It runs inline now, once `awaitTermination` has established that no
   * executor task can ever run again.
   */
  @Test
  fun `a purge that lands after the close barrier still deletes`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0))
    repeat(4) {
      w.write("0123456789012345\n")
      now.addAndGet(1_000)
    }
    w.flush(1, 1000.0)
    w.settleForTesting()
    assertTrue(directory.list()!!.isNotEmpty())

    // The executor is shut down from here on, so the purge below cannot be
    // scheduled at all.
    w.close(1, 1000.0)

    val (outcome, _) = w.clearLogs(2000.0)

    assertTrue("a post-close purge deleted nothing", outcome.durable)
    assertTrue("nothing was counted as deleted", outcome.deletedCount > 0)
    assertTrue(outcome.failedPaths.isEmpty())
    val survivors = directory.list()!!.filter { LogFileWriter.isArtifactName(it, "app.log") }
    assertTrue("artifacts survived a purge that reported durable: $survivors", survivors.isEmpty())
  }

  /**
   * The inline path must not start while the executor is still draining.
   *
   * `shutdown()` refuses new submissions but lets queued tasks finish, so
   * "refused" does not mean "finished" — and a sweep racing a task that is
   * still moving these files has two mutators and can report durable over an
   * artifact about to be rewritten. `awaitTermination` returning false is the
   * only thing standing between those two, and the honest answer when it does
   * is that nothing was deleted.
   */
  @Test
  fun `a purge that lands while the executor is still draining is not durable`() {
    val w = writer()
    w.write("secret\n")
    w.flush(1, 1000.0)

    // Wedge the executor, then close: the barrier queues behind the stall and
    // never runs, `close` gives up on its own budget, and `shutdown()` still
    // happens on the way out. The executor is now shutting down but very much
    // not terminated.
    val release = w.stallForTesting()
    try {
      w.close(1, 50.0)

      val (outcome, _) = w.clearLogs(50.0)

      assertFalse("a purge claimed durability over a draining executor", outcome.durable)
      assertEquals(listOf(File(directory, "app.log").absolutePath), outcome.failedPaths)
      assertEquals(0, outcome.deletedCount)
      assertTrue(
        "the file was deleted by a purge that reported it was not",
        File(directory, "app.log").exists()
      )
    } finally {
      release()
    }
  }

  /**
   * The inline purge reports a failure; it does not throw one.
   *
   * The trap is a Kotlin/Java rule rather than anything about purging: an
   * exception raised inside a `catch` block does **not** flow into a sibling
   * `catch` of the same `try`. The inline path lives inside the
   * `RejectedExecutionException` handler, so the blanket handler beside it
   * cannot cover it, and a throwing `list()`, `delete()` or `syncDirectory`
   * would escape `clearLogs` outright — while the identical failure on the
   * executor path stays inside the task, leaves the outcome at its non-durable
   * initial value, and returns normally.
   *
   * A purge that throws on one path and returns on the other is exactly the
   * divergence this workstream exists to remove, so the inline call has its own
   * `try`.
   */
  @Test
  fun `an inline purge that fails reports it rather than throwing`() {
    val hostile = object : PlatformIo by PlatformIo.Jvm {
      override fun syncDirectory(directory: File): Boolean =
        throw RuntimeException("the volume went away mid-purge")
    }
    val w = writer(platform = hostile)
    w.write("secret\n")
    w.flush(1, 1000.0)
    w.close(1, 1000.0)

    val (outcome, _) = w.clearLogs(2000.0)

    assertFalse("a purge that could not finish claimed durability", outcome.durable)
    assertEquals(listOf(File(directory, "app.log").absolutePath), outcome.failedPaths)
  }

  /**
   * The inline purge deletes and stops there.
   *
   * Reopening after the close barrier would leak a stream for the life of the
   * process and leave a fresh empty `app.log` where a purge had just promised
   * nothing. Note this does **not** consult `terminated`: a close whose own
   * barrier submission was rejected leaves that flag false over a dead
   * executor, so the inline path passes `reopenIfClean = false` outright.
   */
  @Test
  fun `an inline purge never reopens the log file`() {
    val w = writer()
    w.write("secret\n")
    w.flush(1, 1000.0)
    w.close(1, 1000.0)

    val (outcome, _) = w.clearLogs(2000.0)

    assertTrue(outcome.durable)
    assertFalse("a post-close purge rebound a handle onto a dead writer", outcome.rebound)
    assertFalse(
      "the purge reopened the file it had just deleted",
      File(directory, "app.log").exists()
    )
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
      // Was an `if`, which passed in silence on a runtime that can still list
      // the directory — claiming coverage of the worst lie this call can tell
      // over a run that never put it in a position to tell it.
      assumeDirectoryRefusesListing()

      val (outcome, _) = w.clearLogs(2000.0)
      assertFalse("an unreadable directory reported a durable purge", outcome.durable)
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
    // Before the write, so a runtime that ignores the mode skips the test
    // rather than failing the precondition below — which it would, since the
    // reopen succeeds and there is no backoff window to arm.
    assumeDirectoryRefusesWrites()
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

    steady.addAndGet(LogFileWriterConstants.REOPEN_BACKOFF_MS)
    w.write("window elapsed\n")
    w.settleForTesting()
    assertTrue("once the window passes the write reopens", File(logs, "app.log").exists())
  }

  /**
   * The other side of the bypass: past the close barrier there is nothing to
   * reopen INTO, and reopening is not passive — it recreates the directory, the
   * log file and the `.meta` sidecar the close was shutting.
   *
   * **Why this runs inside `onTerminated`.** It is reproducing one specific
   * interleaving and nothing else reaches it. A `flush` enqueued before the
   * barrier runs while `terminated` is still false; a `handle.flush` after
   * `close()` returned is refused by the generation check; and `close()` shuts
   * the executor down, so a plain `writer.flush` afterwards is rejected before
   * `syncNow` can run. The path that matters is a flush *executing on the write
   * thread after the barrier has passed* — which is exactly where
   * `onTerminated` runs, and where a racing `handle.flush` that already cleared
   * the generation check lands. The inline branch in `flushUntil` takes it
   * straight to `syncNow`.
   *
   * iOS grew this guard as C7; the Android twin was left without it, so this is
   * the case that recreated everything on the way out.
   */
  @Test
  fun `a flush that reaches the writer after termination recreates nothing`() {
    val logs = File(directory, "sub")
    val w = writer(name = "sub/app.log")
    w.write("before\n")
    assertTrue(w.flush(1, 1000.0).durable)
    assertTrue(File(logs, "app.log").exists())

    var outcome: LogFlushOutcome? = null
    w.close(1, 1000.0) {
      // On the write thread, immediately past the barrier. Deleting first makes
      // a reopen visible rather than inferred: without the guard every one of
      // these three comes back.
      assertTrue(logs.deleteRecursively())
      outcome = w.flush(1, 1000.0)
    }

    assertNotNull("the barrier callback never ran, so this asserted nothing", outcome)
    assertFalse("a terminated writer cannot sync anything", outcome!!.durable)
    assertFalse("the flush recreated the directory it was closing", logs.exists())
    assertFalse(File(logs, "app.log").exists())
    assertFalse(File(logs, "app.log.meta").exists())
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
      // A runtime that ignores the mode reopens fine and flushes durably, so
      // the assertion below would fail for a reason about the runtime.
      assumeDirectoryRefusesWrites()

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
    // Archives by name, not `artifacts.size > 1`. The age sidecar is written on
    // every open, so `{app.log, app.log.meta}` satisfies a bare count with zero
    // rotations — the guard would have been green on a writer that never
    // rotated at all, which is the failure it was put there to rule out.
    assertTrue("nothing rotated, so this asserted nothing",
               artifacts.any { LogFileWriter.isArchiveName(it.name, "app.log") })
    for (artifact in artifacts) {
      assertEquals("$artifact is readable by more than its owner",
                   ownerOnlyFile, mode(artifact))
    }
  }

  // MARK: - One process at a time

  /**
   * The boundary this exists to enforce.
   *
   * Two processes appending to one log file interleave mid-record and run two
   * rotation schedules over the same names — the collision the registry
   * prevents inside one process, arriving from outside it, where a registry
   * cannot see it. Nothing here makes cross-process *writing* work; it makes
   * the second writer fail loudly instead of quietly corrupting the first
   * one's file.
   *
   * A second `LogFileWriter` in this JVM is the stand-in for a second process:
   * the JDK refuses an overlapping lock on the same file whether the conflict
   * is another process or another channel here, and it is the same refusal.
   */
  @Test
  fun `a second writer on the same file is refused`() {
    writer()

    try {
      writer()
      fail("a second writer took a file another one is holding")
    } catch (expected: LogWriterException) {
      assertEquals(LogWriterException.Kind.LOCKED, expected.kind)
    }
  }

  @Test
  fun `the file can be taken again once the first writer lets go`() {
    val first = writer()
    first.close(1, 1000.0)

    // Not just "does not throw": the replacement has to be able to write.
    val second = writer()
    assertTrue(second.write("after\n").accepted)
  }

  /**
   * The lock lives on a file of its own, and that is load-bearing.
   *
   * A lock follows the inode. Held on the active log file it would ride the
   * rename into the archive at the first rotation and leave the live file
   * unguarded — so the exclusion would silently stop excluding at exactly the
   * moment the file is busiest.
   */
  @Test
  fun `rotation does not carry the lock away with the archived file`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 64.0))
    repeat(6) { w.write("x".repeat(40) + "\n") }
    w.flush(1, 1000.0)
    w.settleForTesting()
    assertTrue("nothing rotated, so this asserted nothing",
               directory.listFiles()!!.any { LogFileWriter.isArchiveName(it.name, "app.log") })

    try {
      writer()
      fail("the lock moved with the archive; the live file is unguarded")
    } catch (expected: LogWriterException) {
      assertEquals(LogWriterException.Kind.LOCKED, expected.kind)
    }
  }

  /**
   * A purge deletes every log byte and leaves the lock, which holds none.
   *
   * Unlinking it would be worse than useless: an advisory lock lives on the
   * inode, so removing the name while a writer holds it lets the next process
   * create a fresh file, lock that one, and append alongside the first.
   */
  @Test
  fun `a purge deletes every artifact and leaves the lock file`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 64.0))
    repeat(6) { w.write("x".repeat(40) + "\n") }
    w.flush(1, 1000.0)
    w.settleForTesting()

    val outcome = w.clearLogs(2000.0)
    assertTrue("the purge did not report itself durable", outcome.first.durable)

    val lock = File(directory, LogFileWriter.lockName("app.log"))
    assertTrue("the purge took the lock file with it", lock.isFile)
    assertEquals("and it must never have held a byte of log data", 0L, lock.length())

    // And it is still held: a purge is not a release.
    try {
      writer()
      fail("the purge dropped the exclusion")
    } catch (expected: LogWriterException) {
      assertEquals(LogWriterException.Kind.LOCKED, expected.kind)
    }
  }

  @Test
  fun `the lock file is not offered to anyone collecting logs`() {
    val w = writer()
    w.write("hello\n")
    w.flush(1, 1000.0)
    w.settleForTesting()

    val name = LogFileWriter.lockName("app.log")
    assertTrue("the lock file was never created, so this asserted nothing",
               File(directory, name).isFile)
    assertFalse("a collector would try to read an empty exclusion file",
                w.logFilePaths().any { it.endsWith(name) })
    assertFalse(LogFileWriter.isArchiveName(name, "app.log"))
    assertFalse("a purge would delete it", LogFileWriter.isArtifactName(name, "app.log"))
  }

  /**
   * A writer that never finished being built must not keep the file locked.
   *
   * The lock is taken before the append open, so an open that fails leaves a
   * descriptor with nothing to release it — and a log file locked for the life
   * of the process by a writer that does not exist is the worst outcome this
   * whole feature could produce.
   */
  @Test
  fun `a writer that fails to open gives the lock back`() {
    // A directory where the log file goes. Resolution is happy with it — it is
    // not a symlink — and the append open is not.
    assertTrue(File(directory, "app.log").mkdirs())

    try {
      writer()
      fail("the writer opened a directory")
    } catch (expected: LogWriterException) {
      assertEquals(LogWriterException.Kind.OPEN_FAILED, expected.kind)
    }

    RandomAccessFile(File(directory, LogFileWriter.lockName("app.log")), "rw").use {
      assertNotNull("the failed writer is still holding the lock", it.channel.tryLock())
    }
  }

  /**
   * A symlink where the lock file goes is not followed.
   *
   * Following it would put the lock — and the mode the writer applies — on a
   * file nobody chose, and could quietly make two unrelated paths exclude each
   * other. The answer is no exclusion rather than the wrong exclusion, which is
   * the same answer iOS reaches from `O_NOFOLLOW`.
   */
  @Test
  fun `a symlinked lock path is not followed`() {
    val target = File(directory, "elsewhere")
    Assume.assumeTrue(
      "this runtime cannot create symlinks",
      runCatching {
        Files.createSymbolicLink(
          File(directory, LogFileWriter.lockName("app.log")).toPath(),
          target.toPath()
        )
      }.isSuccess
    )

    val w = writer()

    assertTrue("logging must keep working", w.write("still here\n").accepted)
    assertTrue("and the caller has to be able to find out",
               w.status(1).degraded and LogDegradation.EXCLUSIVITY != 0)
    assertFalse("the writer created the symlink's target instead of refusing", target.exists())
  }

  /**
   * A filesystem that will not lock is a degradation, not a failure.
   *
   * Refusing to log because the storage cannot exclude would be a far worse
   * answer than logging without the guarantee — so the bit goes up, the caller
   * can read it, and the writer carries on. Reached here by putting a
   * *directory* where the lock file goes, which is a real filesystem refusing a
   * real open; the other route to the same decision is a filesystem whose
   * `tryLock` fails, which no temp directory on a developer machine will do.
   */
  @Test
  fun `a file that cannot be locked degrades rather than refusing to log`() {
    assertTrue(File(directory, LogFileWriter.lockName("app.log")).mkdirs())

    val w = writer()

    assertTrue("logging must keep working", w.write("still here\n").accepted)
    assertTrue("and the caller has to be able to find out",
               w.status(1).degraded and LogDegradation.EXCLUSIVITY != 0)
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
   * The writer records what it could not do; it does not pretend to have done
   * it, and it does not refuse to log over it.
   */
  @Test
  fun `the writer reports rather than repairs a directory it cannot secure`() {
    // With a control, because `PROTECTION` is a folded bit with eleven
    // contributors — the directory, the log file, the sidecar, every archive
    // and every staging file. "Some route set it" is not the claim; "the
    // refused `restrictToOwner` set it" is, and only a writer on the
    // unmodified platform can tell those apart.
    val control = writer(name = "control.log")
    control.write("x\n")
    control.flush(1, 500.0)
    assertEquals(
      "nothing is wrong here, so the assertion below distinguishes something",
      0,
      control.status(1).degraded and LogDegradation.PROTECTION
    )

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
      // The guard its PRUNE sibling below has always had. Under a root JVM the
      // rename succeeds, the rotation is clean, ROTATION is correctly unset,
      // and this fails red over an environment rather than a defect.
      assumeDirectoryRefusesWrites()

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

  // MARK: - Maintenance without a write

  /// The whole reason [LogFileWriter.maintain] exists. Rotation runs from
  /// `performWrite` and nowhere else, so a sink nobody is logging to never
  /// age-rotates however long it sits there.
  @Test
  fun `maintain age rotates a file nothing is writing to`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileAgeSeconds = 60.0))
    w.write("early\n")
    w.flush(1, 1000.0)
    w.settleForTesting()

    now.addAndGet(61_000)

    // The control, and the point: the file is old enough to rotate and stays
    // put, because nothing has written to it. Without this the assertion below
    // would pass against a writer that rotated on its own.
    assertTrue("an unwritten file rotated itself", archives().isEmpty())

    w.maintain(1, 1000.0)
    w.settleForTesting()

    assertEquals(1, archives().size)
  }

  /// The other half: an archive that expired while the app sat idle.
  @Test
  fun `maintain prunes an expired archive with no writes`() {
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

    val rotated = archives()
    assertTrue(rotated.isNotEmpty())
    rotated.forEach { File(directory, it).setLastModified(now.get() - 120_000) }

    now.addAndGet(1_000)
    assertEquals("retention does not sweep itself either", rotated.size, archives().size)

    w.maintain(1, 1000.0)
    w.settleForTesting()

    assertTrue("the expired archive survived", archives().none { it in rotated })
  }

  /// A flush is not a sweep. Both take a deadline and both go on the writer's
  /// executor, which is exactly why someone would reach for the wrong one.
  @Test
  fun `flush does not stand in for maintain`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileAgeSeconds = 60.0))
    w.write("early\n")
    w.flush(1, 1000.0)
    w.settleForTesting()

    now.addAndGet(61_000)
    w.flush(1, 1000.0)
    w.settleForTesting()

    assertTrue("flush drains the queue and moves no files", archives().isEmpty())
  }

  /// The status has to describe what this call found, not what the last append
  /// left behind — a destination nobody writes to has no next append.
  @Test
  fun `maintain reports what the sweep itself broke`() {
    val w = writer(
      policy = LogRotationPolicy.of(maxFileAgeSeconds = 60.0, compressArchives = true),
      compressor = { _, _ -> false }
    )
    w.write("early\n")
    w.flush(1, 1000.0)
    w.settleForTesting()
    assertEquals(0, w.status(1).degraded and LogDegradation.GZIP)

    now.addAndGet(61_000)
    val status = w.maintain(1, 1000.0)

    assertTrue(
      "the compression this sweep failed is missing from the status it returned",
      status.degraded and LogDegradation.GZIP != 0
    )
  }

  /// A terminated writer no longer owns the path, and the retention sweep is
  /// the half of maintenance that needs no stream to do damage: it works off a
  /// directory listing, so it would happily expire archives under whichever
  /// writer holds the path now, under a policy that one never agreed to.
  ///
  /// **What this does not prove.** What stops it here is [close] shutting the
  /// executor down, which rejects the sweep before it is ever queued — remove
  /// the `terminated` check inside `maintain` and this test still passes. That
  /// check is the second line, for a sweep enqueued in the window between the
  /// close barrier being submitted and the shutdown that follows it, and no
  /// caller can reach that window today: `LogFileHandle.maintain` refuses on a
  /// released handle, and the writer is only closed once the last handle is
  /// released. iOS has no executor to shut down, so there the same check is the
  /// only line and `testMaintainAfterTerminationSweepsNothing` pins it.
  @Test
  fun `maintain after close sweeps nothing`() {
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

    val rotated = archives()
    assertTrue(rotated.isNotEmpty())
    rotated.forEach { File(directory, it).setLastModified(now.get() - 120_000) }

    w.close(1, 1000.0)
    now.addAndGet(1_000)
    w.maintain(1, 1000.0)

    assertEquals("an archive this writer no longer owns is not its to expire",
                 rotated.sorted(), archives().sorted())
    assertTrue(File(directory, "app.log").exists())
  }

  private fun archives(): List<String> =
    directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }

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
      now.addAndGet(1_000)
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
    assertEquals(now.get().toString(), File(directory, "app.log.meta").readText().trim())
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
      override fun creationTimeMillis(file: File): Long? = now.get()
    }

    // A previous run recorded the real creation time an hour ago.
    File(directory, "app.log.meta").writeText((now.get() - 3_600_000).toString())

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
    File(directory, "app.log.meta").writeText((now.get() + 86_400_000).toString())

    val w = writer(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 1e9, maxFileAgeSeconds = 60.0)
    )
    w.settleForTesting()

    // Rewritten to something the clock has already reached. Not asserted equal
    // to `now`: a plausible filesystem creation time is allowed to win the seed,
    // and on a one-second-granularity filesystem that is a little earlier.
    val rewritten = File(directory, "app.log.meta").readText().trim().toLong()
    assertTrue("the sidecar is still in the future: $rewritten vs $now", rewritten <= now.get())

    // And with a sane start time, age rotation still works.
    now.addAndGet(61_000)
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

    now.addAndGet(61_000)
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
    sidecar.writeText((now.get() - 3_600_000).toString())

    val w = writer(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 1e9, maxFileAgeSeconds = 60.0),
      platform = platform
    )
    w.settleForTesting()

    // Read-only, so every attempt to record the fresh time fails.
    assertTrue(sidecar.setWritable(false, false))
    assumeFileRefusesWrites(sidecar)
    refuseOpen = true

    w.write("rotate me\n")
    w.settleForTesting()
    assertEquals(1, directory.list()!!.count { LogFileWriter.isArchiveName(it, "app.log") })
    assertFalse("the reopen was supposed to fail", w.hasLiveStreamForTesting)
    assertEquals(
      "the stale sidecar should not have been overwritten",
      (now.get() - 3_600_000).toString(),
      sidecar.readText().trim()
    )

    // Let the file open again, past the reopen backoff.
    refuseOpen = false
    steady.addAndGet(5_000)

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
        // Deletion is what has to fail here; a runtime that can unlink anyway
        // never reaches the fallback lookup this is about.
        assumeDirectoryRefusesWrites()

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
      now.addAndGet(-3_600_000) // the wall clock steps back an hour, mid-flight
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
      now.addAndGet(1_000)
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

  /**
   * The closed-sink half of the `getLogFilePaths` row: a released writer does
   * not unmake its files, and the same names have to come back without one.
   */
  @Test
  fun `artifact paths lists the same files with no live writer`() {
    val w = writer(policy = LogRotationPolicy.of(maxFileSizeBytes = 16.0))
    repeat(6) {
      w.write("0123456789012345\n")
      now.addAndGet(1_000)
    }
    w.flush(1, 1000.0)
    w.settleForTesting()
    val live = w.logFilePaths()
    w.close(1, 1000.0)

    val dead = LogFileWriter.artifactPaths(File(directory, "app.log"))

    assertEquals("the files did not move when the writer went away", live.toSet(), dead.toSet())
    assertTrue("no archives rotated, so this compared almost nothing", dead.size > 1)
  }

  /**
   * The one case that answers with nothing: a path where no file was ever
   * written. The active name is included only when it is really there, so a
   * collector is never sent to open a file that does not exist.
   */
  @Test
  fun `artifact paths at an untouched path is empty`() {
    assertEquals(
      emptyList<String>(),
      LogFileWriter.artifactPaths(File(directory, "never-opened.log"))
    )
  }
}

/** Mirror of the writer's private stride, so the liveness test can drive past it. */
object LogFileWriterConstants {
  const val HEALTH_CHECK_STRIDE = 8

  /** Mirrors the writer's private `REOPEN_BACKOFF_MS`. */
  const val REOPEN_BACKOFF_MS = 1_000L

  /**
   * Mirrors the writer's private `ROTATION_BACKOFF_MS`.
   *
   * A hand-copied constant drifts, and it is worth being exact about which
   * direction goes unnoticed. A test advances the clock by this plus one, so
   * a production window that *grows* past the mirror leaves the window shut
   * and the test red — caught. One that *shrinks* is still cleared by an
   * over-long advance, so the test stays green having proved the weaker
   * statement that the window reopens eventually. Both are worth having;
   * only the first is guarded.
   */
  const val ROTATION_BACKOFF_MS = 5_000L
}
