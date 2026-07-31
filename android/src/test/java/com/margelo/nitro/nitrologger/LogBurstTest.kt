package com.margelo.nitro.nitrologger

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.zip.GZIPInputStream

/**
 * Volume and concurrency, the Kotlin twin of `LogBurstTests.swift`.
 *
 * The other suites prove each rule on its own; these prove the rules still
 * hold when everything happens at once — ten thousand records through one
 * handle, four threads through one writer, a purge in the middle of sustained
 * logging.
 *
 * ## What this does NOT prove
 *
 * It runs on `PlatformIo.Jvm` against a JVM temp directory, which on a
 * developer machine is very likely a tmpfs. That is not a phone under memory
 * pressure with a slow eMMC and a scheduler that has better things to do, and
 * no unit test on any host is going to be. What it does establish is the part
 * that is not about the device: that nothing tears, nothing is lost, nothing is
 * counted twice, and no operation deadlocks against another when they overlap.
 *
 * It also does not measure latency. See
 * `status polling stays responsive under load` for why the deterministic
 * formulation replaced a timing bound rather than joining it.
 */
class LogBurstTest {
  private lateinit var directory: File
  private lateinit var registry: LogWriterRegistry
  private val handles = mutableListOf<LogFileHandle>()
  private val releases = mutableListOf<() -> Unit>()

  /** See `LogFileWriterTest.now` — same field, same reason it is atomic. */
  private val now = AtomicLong(System.currentTimeMillis())

  @Before
  fun setUp() {
    now.set(System.currentTimeMillis())
    directory = File.createTempFile("nitro-burst-test", "").let {
      it.delete()
      File(it.absolutePath + "-dir").apply { mkdirs() }
    }
    registry = LogWriterRegistry.isolated()
  }

  @After
  fun tearDown() {
    // Gates first. A handle whose writer is parked on a latch cannot close, and
    // a test that failed before its own release would otherwise turn one clear
    // assertion failure into a teardown that waits out every deadline.
    releases.forEach { runCatching { it() } }
    releases.clear()
    handles.forEach { runCatching { it.close(1000.0) } }
    handles.clear()
    directory.deleteRecursively()
  }

  private fun logPath(name: String = "app.log") = File(directory, name).absolutePath

  private fun handle(
    policy: LogRotationPolicy = LogRotationPolicy.of(),
    name: String = "app.log"
  ): LogFileHandle = registry.acquire(
    path = logPath(name),
    policy = policy,
    lineFramed = true,
    platform = PlatformIo.Jvm,
    clock = { now.get() }
  ).also { handles.add(it) }

  private fun stall(handle: LogFileHandle): () -> Unit {
    val release = handle.writerForTesting.stallForTesting()
    releases.add(release)
    return release
  }

  /**
   * Fixed width, so a torn or interleaved record is obvious rather than
   * plausible: eight digits, a space, forty `x`, a newline. Anything that is
   * not 49 characters between newlines was damaged in transit.
   */
  private fun line(index: Int) = "%08d ".format(index) + "x".repeat(40) + "\n"

  private fun contents(name: String = "app.log") =
    File(directory, name).let { if (it.isFile) it.readText() else "" }

  private fun names() = (directory.list() ?: emptyArray()).sorted()

  /**
   * A compressed archive's payload, every member of it.
   *
   * `LogCollectTest` has the same three lines. Kept local for the same reason
   * it is local there: this target has no shared test base, and the two suites
   * are asking different questions of it.
   */
  private fun gunzip(file: File): String =
    GZIPInputStream(file.inputStream().buffered()).use {
      String(it.readBytes(), Charsets.UTF_8)
    }

  private fun archiveNames() =
    names().filter { it != "app.log" && it != LogFileWriter.lockName("app.log") }

  /**
   * Appends, answering backpressure the way the JavaScript batcher does.
   *
   * `FULL` is not a failure — it is the writer saying the queue is at its cap,
   * and the caller's job is to flush and come back. A burst test that treated
   * it as one would be measuring the queue depth rather than the writer.
   */
  private fun push(handle: LogFileHandle, text: String, spinLimit: Int = 1000): Boolean {
    var result = handle.appendBatch(text, 1L)
    var spins = 0
    while (!result.accepted && result.rejectReason == LogRejectReason.FULL && spins < spinLimit) {
      handle.flush(1000.0)
      result = handle.appendBatch(text, 1L)
      spins += 1
    }
    return result.accepted
  }

  // MARK: - Volume

  /** The sanity burst: ten thousand records, every one intact and in order. */
  @Test
  fun `ten thousand records survive intact and in order`() {
    val h = handle(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0))

    var accepted = 0
    for (index in 0 until 10_000) if (push(h, line(index))) accepted += 1

    assertEquals(10_000, accepted)
    assertTrue(h.flush(10_000.0).durable)
    assertEquals(0L, h.status().lostEntries)
    assertEquals(0L, h.status().queuedBytes)

    val lines = contents().split("\n").dropLast(1)
    assertEquals(10_000, lines.size)
    lines.forEachIndexed { index, text ->
      assertEquals("record $index is torn", 49, text.length)
      assertTrue("record $index is out of order", text.startsWith("%08d ".format(index)))
    }
  }

  /**
   * Rotation under load: nothing is lost, and every record ends up in exactly
   * one file.
   *
   * The duplicate check is the half that matters. A rotation that copied
   * instead of renaming, or that wrote a record to the old file and the new
   * one, would still produce a total count that looks right if anything else
   * was dropped — so records are identified rather than counted.
   */
  @Test
  fun `a burst across many rotations loses nothing`() {
    val h = handle(
      LogRotationPolicy.of(
        maxFileSizeBytes = 4096.0,
        maxArchivedFilesCount = 10_000.0,
        compressArchives = false
      )
    )

    val total = 4_000
    for (index in 0 until total) {
      assertTrue("record $index", push(h, line(index)))
    }
    assertTrue(h.flush(10_000.0).durable)
    // The anti-vacuity gate. Everything below passes over a single unrotated
    // file, which is what a policy that silently failed to apply would leave.
    assertTrue("the burst really did rotate", archiveNames().size > 10)

    val seen = mutableSetOf<Int>()
    for (path in h.logFilePaths()) {
      val file = File(path)
      for (record in file.readText().split("\n").filter { it.isNotEmpty() }) {
        assertEquals("torn record in ${file.name}", 49, record.length)
        val index = record.take(8).toIntOrNull()
        assertNotNull("unreadable record in ${file.name}: $record", index)
        assertTrue("record $index appears twice", seen.add(index!!))
      }
    }
    // The identities, not the count. A writer that rewrote every index while
    // keeping them unique, 49 characters wide and 4,000 in number satisfies a
    // size comparison and has still corrupted every record it wrote.
    assertEquals("every record is in exactly one file", (0 until total).toSet(), seen)
  }

  /**
   * Several JavaScript runtimes can hold handles on one file.
   *
   * Records may interleave *between* handles — the writer never promised
   * otherwise, and one file with two producers is a documented configuration
   * rather than a mistake. What must never happen is a record interleaving with
   * itself, which is what the fixed width catches.
   */
  @Test
  fun `concurrent handles never tear a record`() {
    val handleCount = 4
    val perHandle = 500
    val policy = LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0)
    val workers = (0 until handleCount).map { handle(policy) }

    val start = CountDownLatch(1)
    val done = CountDownLatch(handleCount)
    val threads = workers.mapIndexed { worker, h ->
      Thread {
        start.await()
        try {
          for (index in 0 until perHandle) {
            push(h, "%02d-%06d ".format(worker, index) + "y".repeat(40) + "\n")
          }
        } finally {
          done.countDown()
        }
      }.apply { isDaemon = true; this.start() }
    }
    start.countDown()
    assertTrue("a writing thread never finished", done.await(60, TimeUnit.SECONDS))
    threads.forEach { it.join(5_000) }

    assertTrue(workers[0].flush(10_000.0).durable)

    val lines = contents().split("\n").filter { it.isNotEmpty() }
    assertEquals(handleCount * perHandle, lines.size)
    val seen = mutableSetOf<String>()
    for (text in lines) {
      assertEquals("a record was torn by a concurrent write", 50, text.length)
      assertTrue("duplicate record: ${text.take(9)}", seen.add(text.take(9)))
    }
    assertEquals(handleCount * perHandle, seen.size)
  }

  /**
   * The backpressure loop polls status from the JavaScript thread while the
   * writer thread is busy. That must never block, and must never hand back a
   * number that has been half-updated.
   *
   * The writer queue is **gated shut** for the duration rather than merely
   * loaded up, and that is what makes this deterministic. Racing a producer
   * against a poll loop asks whether the machine scheduled the poller before
   * the producer finished — a question about the runner, answered differently
   * on a loaded CI box, where the loop can run zero times and the test passes
   * having proven nothing. With the queue gated, this is not a latency
   * measurement at all: every poll below happens while a task is provably stuck
   * on the queue, so a `status()` that took the queue would deadlock rather
   * than merely be slow.
   *
   * Which is why the timeout is on the annotation. A deadlock is the failure
   * this test exists to catch, and JUnit's `timeout` runs the body on its own
   * thread so it is reported as a failure with a stack rather than as a build
   * that hung. Thirty seconds is not a performance bound — it is far beyond any
   * honest execution of this method, and nothing about it is tuned.
   */
  @Test(timeout = 30_000)
  fun `status polling stays responsive under load`() {
    val h = handle(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0))
    val release = stall(h)

    // Enough to put real bytes in flight behind the gate. These are accepted
    // into the queue and cannot drain, so `queuedBytes` is non-zero by
    // construction rather than by luck. No `push` here on purpose: its flush
    // would block on the gate, and a refusal is a legitimate answer once the
    // queue fills.
    var accepted = 0
    for (index in 0 until 200) {
      if (h.appendBatch(line(index), 1L).accepted) accepted += 1
    }
    assertTrue("the gate should not have refused everything", accepted > 0)

    var sawWorkInFlight = false
    repeat(50) {
      val status = h.status()
      if (status.queuedBytes > 0) sawWorkInFlight = true
      assertTrue(status.queuedBytes >= 0)
      assertTrue(
        "queued ${status.queuedBytes} is past the hard cap",
        status.queuedBytes <= LogFileWriter.HARD_CAP_BYTES
      )
      assertTrue(status.lostEntries >= 0)
    }

    // The anti-vacuity gate: without it every assertion above is satisfied by a
    // status that reports zeros forever.
    assertTrue(
      "the writer is gated with accepted bytes behind it, so status must see them",
      sawWorkInFlight
    )

    release()
    assertTrue(h.flush(10_000.0).durable)
    assertEquals("the gate lifted and the queue drained", 0L, h.status().queuedBytes)
  }

  /**
   * The whole lifecycle at once: writing, rotating, compressing, purging, and
   * writing again.
   *
   * The invariant a compliance caller depends on is that a purge leaves nothing
   * behind *and* the sink still works afterwards. Either one alone is easy; a
   * purge that took the writer down with it would pass the first.
   */
  @Test
  fun `a purge during sustained logging leaves a working sink`() {
    val h = handle(
      LogRotationPolicy.of(
        maxFileSizeBytes = 2048.0,
        maxArchivedFilesCount = 100.0,
        compressArchives = true
      )
    )

    for (index in 0 until 600) assertTrue("pre-purge record $index", push(h, line(index)))
    h.flush(10_000.0)
    assertTrue("nothing rotated, so the purge below has nothing to prove", archiveNames().size > 3)

    val cleared = h.clearLogs(5_000.0)
    assertTrue(cleared.durable)
    // `rebound` is the field the JS destination reads to decide whether it may
    // resume, and it is a separate claim from `durable`: a purge that deleted
    // everything and could not reopen is durable and unusable. Everything below
    // depends on this being true, so it is asserted rather than assumed.
    assertTrue("the purge did not rebind, so the sink below is not the sink", cleared.rebound)
    // Every archive gone, and the exact list rather than a count: a purge that
    // spared one `.gz` is the failure this whole call exists to prevent, and
    // over a hundred archives that is not something a total would show.
    //
    // Three names, where the iOS twin asserts two. The lock is not an artifact
    // and is deliberately kept; the sidecar *was* purged with everything else
    // and is then written again by the rebind, describing the fresh file. That
    // it is a new one rather than a survivor is `a purge sweeps the sidecar and
    // every staging file`, which watches the deletion directly — asserting it
    // from here would mean comparing recorded milliseconds against a filesystem
    // whose creation-time granularity is a second on some hosts.
    assertEquals(
      listOf("app.log", LogFileWriter.lockName("app.log"), "app.log.meta"),
      names()
    )
    assertEquals(0L, h.status().lostEntries)

    // A disjoint range, so a pre-purge record that survived is not merely
    // uncounted but *identifiable*: any index below 100_000 in the sweep below
    // is data the purge promised was gone.
    val after = (100_000 until 100_600).toList()
    for (index in after) assertTrue("post-purge record $index", push(h, line(index)))
    assertTrue(h.flush(10_000.0).durable)
    // The compressor runs on the executor, and a `.gz` still being written is
    // not a `.gz` this can read.
    h.writerForTesting.settleForTesting()

    // Every artifact, archives included. Skipping the `.gz` files — which an
    // earlier draft did — leaves this asserting that *one* record came back,
    // over a burst that rotates a dozen times: a rebind that accepted the first
    // record and dropped the other 599 would have passed.
    val seen = mutableSetOf<Int>()
    for (path in h.logFilePaths()) {
      val file = File(path)
      val text = if (file.name.endsWith(".gz")) gunzip(file) else file.readText()
      for (record in text.split("\n").filter { it.isNotEmpty() }) {
        assertEquals("torn record in ${file.name}", 49, record.length)
        val index = record.take(8).toIntOrNull()
        assertNotNull("unreadable record in ${file.name}: $record", index)
        assertTrue("record $index appears twice", seen.add(index!!))
      }
    }
    assertEquals("the sink came back and kept every record", after.toSet(), seen)
  }
}
