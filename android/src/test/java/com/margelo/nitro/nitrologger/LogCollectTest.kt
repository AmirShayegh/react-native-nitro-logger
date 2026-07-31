package com.margelo.nitro.nitrologger

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/**
 * The support bundle.
 *
 * The claim under test is not "a file appeared" but "gunzip on it gives you the
 * whole log, in order", so these decompress with [GZIPInputStream] rather than
 * with a helper written alongside the writer — and specifically with the
 * multi-member reading a real tool does. A single-member reader would stop
 * after the first archive and call the bundle correct.
 */
class LogCollectTest {
  private lateinit var directory: File
  private var now = System.currentTimeMillis()
  private var steady = 0L
  private val opened = mutableListOf<LogFileWriter>()

  @Before
  fun setUp() {
    now = System.currentTimeMillis()
    steady = 0L
    directory = File.createTempFile("nitro-collect-test", "").let {
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
    policy: LogRotationPolicy = LogRotationPolicy.of(),
    compressor: LogFileWriter.Compressor? = null
  ): LogFileWriter {
    val file = File(directory, "app.log")
    return LogFileWriter.open(
      file = file,
      canonicalPath = file.absolutePath,
      policy = policy,
      lineFramed = true,
      platform = PlatformIo.Jvm,
      compressor = compressor,
      clock = { now },
      monotonic = { steady }
    ).also { opened.add(it) }
  }

  private fun LogFileWriter.write(text: String) =
    append(1, currentGeneration, text, 1)

  /**
   * A 40-byte record that says which one it is, so a bundle can be checked for
   * both content and order. Padded to a fixed width because rotation is by size
   * and these tests want it to fire predictably.
   */
  private fun line(index: Int): String {
    val head = "line$index"
    return head + "x".repeat(39 - head.length) + "\n"
  }

  private val bundle: File
    get() = File(directory, LogFileWriter.supportName("app.log"))

  /**
   * Writes [count] records, giving every archive rotation produces a distinct
   * modification time in the order it was created.
   *
   * Archives are ordered by mtime; the name only breaks exact ties, and its
   * stamp has one-second resolution with a random suffix after it. Records this
   * small are written microseconds apart and land in the same millisecond, so
   * without this the order of two archives is the order of two random hex
   * strings — and a test of "the bundle is chronological" would pass or fail on
   * that. Production rotations are megabytes apart and get the separation for
   * free; a test has to buy it.
   *
   * What this does not prove: how the writer orders two archives that really do
   * share a modification time. Nothing does — see `LogFileWriter.archives` — and
   * a bundle built from those two is in an arbitrary order between them.
   */
  private fun LogFileWriter.writeRotating(count: Int) {
    val stamped = mutableSetOf<String>()
    var stamp = 1_700_000_000_000L
    repeat(count) { index ->
      write(line(index))
      flush(1, 1000.0)
      settleForTesting()
      archiveNames().filter { stamped.add(it) }.sorted().forEach {
        stamp += 10_000L
        File(directory, it).setLastModified(stamp)
      }
    }
  }

  /**
   * Every member, not just the first.
   *
   * `GZIPInputStream` reads concatenated members as one stream — that is the
   * documented behaviour and it is the same thing `gunzip` does, which is what
   * makes the bundle format work at all. The tests that use this also assert
   * `sourceFileCount > 1`, so a reader that silently stopped after the first
   * member would fail on content rather than pass on a bundle it half-read.
   */
  private fun gunzipAll(file: File): String =
    GZIPInputStream(file.inputStream().buffered()).use {
      String(it.readBytes(), Charsets.UTF_8)
    }

  // MARK: - The bundle is the log

  @Test
  fun `the bundle gunzips to the whole log in order`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 64.0, compressArchives = true))
    w.writeRotating(6)
    assertTrue("the test needs something rotated", archiveNames().isNotEmpty())

    val outcome = w.collectLogs(1, 5000.0, 10_000_000.0)

    assertTrue(outcome.complete)
    assertFalse(outcome.truncated)
    assertEquals(bundle.absolutePath, outcome.path)
    assertTrue(outcome.byteCount > 0)
    // The reader below has to cross a member boundary for the assertion after
    // it to mean anything.
    assertTrue("nothing was concatenated", outcome.sourceFileCount > 1)

    // Chronological, and every record exactly once. Selection runs newest first
    // and writing runs oldest first; getting that backwards would give a
    // support engineer the log in reverse blocks, which reads as corruption.
    assertEquals(
      (0 until 6).joinToString("") { line(it) },
      gunzipAll(bundle)
    )
  }

  @Test
  fun `a plaintext archive is compressed into the bundle`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 64.0, compressArchives = false))
    w.writeRotating(6)
    assertTrue(archiveNames().none { it.endsWith(".gz") })

    val outcome = w.collectLogs(1, 5000.0, 10_000_000.0)

    assertTrue(outcome.complete)
    assertTrue("nothing was concatenated", outcome.sourceFileCount > 1)
    assertEquals((0 until 6).joinToString("") { line(it) }, gunzipAll(bundle))
  }

  @Test
  fun `collecting twice replaces the bundle rather than growing it`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0))
    w.write("first\n")
    w.flush(1, 1000.0)
    w.collectLogs(1, 5000.0, 10_000_000.0)

    w.write("second\n")
    w.flush(1, 1000.0)
    val outcome = w.collectLogs(1, 5000.0, 10_000_000.0)

    assertTrue(outcome.complete)
    assertEquals("first\nsecond\n", gunzipAll(bundle))
    assertEquals(
      listOf(LogFileWriter.supportName("app.log")),
      directory.list()!!.filter { it.startsWith("app.log.support") }.sorted()
    )
  }

  /**
   * Real gzip for rotation, a refusal for the scratch file a collect compresses
   * a plaintext source into.
   *
   * [LogFileWriter] has one compressor and this test needs both: rotation's use
   * of it has to work so there are archives to pack, and the collect's use of
   * it has to fail so there is a member that does not go in.
   */
  private fun compressorRefusingMembers() = LogFileWriter.Compressor { source, destination ->
    if (destination.name.endsWith(".member")) false else realGzip(source, destination)
  }

  /**
   * Real gzip, so an injected compressor produces a file the rest of the
   * collect can actually read.
   *
   * A stub that returns `true` without writing anything looks like a working
   * compressor and is not one: every member then fails to copy, the collect
   * bails on "nothing was written", and a test aimed at some later step never
   * reaches it.
   */
  private fun realGzip(source: File, destination: File): Boolean {
    GZIPOutputStream(destination.outputStream().buffered()).use { out ->
      source.inputStream().use { it.copyTo(out) }
    }
    return true
  }

  /**
   * A member that cannot be written must leave the bundle a bundle.
   *
   * This is the failure that has to not corrupt anything: the sources are
   * written one after another into one stream, so a member abandoned halfway
   * would sit in front of the next one and the result would not be gzip at all.
   * What comes back has to still gunzip, and the records that did go in have to
   * still be in order.
   */
  @Test
  fun `a member that fails leaves the rest readable`() {
    val w = writer(
      LogRotationPolicy.of(maxFileSizeBytes = 64.0, compressArchives = true),
      compressor = compressorRefusingMembers()
    )
    // An ODD count, so the active file still holds a record when the collect
    // starts. Rotation empties it on every even one, and an empty active file
    // is not a source — there would be no plaintext member to fail.
    w.writeRotating(7)
    assertTrue("the test needs archives to keep", archiveNames().size > 1)

    val outcome = w.collectLogs(1, 5000.0, 10_000_000.0)

    // The active file is the plaintext one, so it is the member that failed.
    assertTrue("a dropped member is a truncated bundle", outcome.truncated)
    assertTrue("the rest of the bundle was still written", outcome.complete)
    assertTrue(outcome.sourceFileCount > 0)

    val restored = gunzipAll(bundle)
    assertTrue("gzip read the bundle but it held nothing", restored.isNotEmpty())
    // In order, and with no fragment of the member that failed. The archived
    // records are the oldest ones.
    assertEquals(
      "the bundle is not the records that went in, in order",
      (0 until outcome.sourceFileCount.toInt() * 2).joinToString("") { line(it) },
      restored
    )
  }

  // MARK: - The ceiling

  @Test
  fun `the ceiling leaves the oldest out`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 64.0))
    w.writeRotating(6)

    // Files with something in them, newest first — an empty active file is not
    // a source, so it is not what a ceiling has to make room for either.
    val sizes = w.logFilePaths().map { File(it).length() }.filter { it > 0 }
    assertTrue("the ceiling has to cut something", sizes.size > 2)
    // Room for the two newest, no more.
    val cap = (sizes[0] + sizes[1]).toDouble()

    val outcome = w.collectLogs(1, 5000.0, cap)

    assertTrue("a ceiling that cuts the log is still a finished collect", outcome.complete)
    assertTrue(outcome.truncated)
    assertEquals(2.0, outcome.sourceFileCount, 0.0)

    // And what survived is the NEWEST end. A bundle that kept the oldest
    // records would be the half nobody is asking about.
    val restored = gunzipAll(bundle)
    assertTrue("the newest record is missing", restored.contains(line(5)))
    assertFalse("the oldest record should have been cut", restored.contains(line(0)))
  }

  @Test
  fun `a ceiling of zero produces no bundle`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0))
    w.write("secret\n")
    w.flush(1, 1000.0)

    val outcome = w.collectLogs(1, 5000.0, 0.0)

    assertEquals("", outcome.path)
    assertEquals(0.0, outcome.sourceFileCount, 0.0)
    assertTrue("everything was left out", outcome.truncated)
    assertTrue("and it finished doing that", outcome.complete)
    assertFalse(bundle.exists())
  }

  /**
   * The direction a broken number has to fail in. `NaN` reaching here means
   * some arithmetic upstream went wrong, and reading that as "no ceiling" would
   * send the whole log.
   */
  @Test
  fun `a non-numeric ceiling sends nothing`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0))
    w.write("secret\n")
    w.flush(1, 1000.0)

    // POSITIVE_INFINITY belongs here more than any of the others: it is what a
    // division by zero produces, and it is the one value a `!isNaN` check would
    // wave through as "no ceiling".
    val broken = listOf(Double.NaN, -1.0, Double.NEGATIVE_INFINITY, Double.POSITIVE_INFINITY)
    for (ceiling in broken) {
      val outcome = w.collectLogs(1, 5000.0, ceiling)
      assertEquals("$ceiling produced a bundle", "", outcome.path)
      assertFalse(bundle.exists())
    }
  }

  /**
   * A ceiling of zero on a sink that has written nothing must still produce no
   * bundle. An empty active file measures zero bytes and would otherwise slip
   * under any ceiling, including one that means "send nothing".
   */
  @Test
  fun `a ceiling of zero on an empty log produces no bundle`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0))

    val outcome = w.collectLogs(1, 5000.0, 0.0)

    assertEquals("", outcome.path)
    assertTrue(outcome.complete)
    assertFalse("nothing was left out of a log with nothing in it", outcome.truncated)
    assertFalse(bundle.exists())
  }

  /**
   * The active file is plaintext whatever it is called. A writer that decided
   * otherwise from the extension would copy raw JSON Lines into the bundle and
   * hand back a `.gz` that no tool can open.
   */
  @Test
  fun `an active file named gz is still compressed in`() {
    val file = File(directory, "app.gz")
    val w = LogFileWriter.open(
      file = file,
      canonicalPath = file.absolutePath,
      policy = LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0),
      lineFramed = true,
      platform = PlatformIo.Jvm,
      compressor = null,
      clock = { now },
      monotonic = { steady }
    ).also { opened.add(it) }
    w.write("plain text\n")
    w.flush(1, 1000.0)

    val outcome = w.collectLogs(1, 5000.0, 10_000_000.0)
    assertTrue(outcome.complete)

    val packed = File(directory, LogFileWriter.supportName("app.gz"))
    assertEquals(packed.absolutePath, outcome.path)
    assertEquals("plain text\n", gunzipAll(packed))
  }

  // MARK: - Where the bundle sits in the naming scheme

  @Test
  fun `the bundle is neither an archive nor a log file path`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 64.0))
    w.writeRotating(6)
    w.collectLogs(1, 5000.0, 10_000_000.0)

    val name = LogFileWriter.supportName("app.log")
    assertTrue(bundle.exists())

    // Not an archive: retention must not count it toward a cap or prune it in
    // place of a real one.
    assertFalse(LogFileWriter.isArchiveName(name, "app.log"))
    // Not a log file: a collector handed this path would be uploading a bundle
    // of the logs as if it were one of them.
    assertFalse(w.logFilePaths().contains(bundle.absolutePath))
    // But an artifact, which is what makes the purge below correct.
    assertTrue(LogFileWriter.isArtifactName(name, "app.log"))
  }

  /**
   * A compliance purge that left a gzipped copy of the whole log next to the
   * files it deleted would not be a purge.
   */
  @Test
  fun `a purge deletes the bundle`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 64.0))
    w.writeRotating(6)
    w.collectLogs(1, 5000.0, 10_000_000.0)
    assertTrue(bundle.exists())

    val outcome = w.clearLogs(5000.0)

    assertTrue(outcome.first.durable)
    assertFalse(
      "the purge reported durable with a copy of the log still on disk",
      bundle.exists()
    )
  }

  /**
   * A collect that died mid-write leaves two kinds of leftover, and both hold
   * log bytes: the half-written bundle, and the scratch file a plaintext source
   * was being compressed into. Neither will ever be finished.
   */
  @Test
  fun `an abandoned staging bundle is swept away`() {
    val orphans = listOf(
      LogFileWriter.supportStagingName("app.log"),
      LogFileWriter.supportMemberName("app.log")
    ).map { File(directory, it) }
    orphans.forEach {
      it.writeText("truncated")
      // An artifact, so a purge would take it too. A leftover the purge did not
      // know about would survive a compliance deletion holding a compressed
      // copy of the log.
      assertTrue("${it.name} is not an artifact",
        LogFileWriter.isArtifactName(it.name, "app.log"))
    }

    // The sweep runs at open.
    val w = writer()
    w.settleForTesting()

    orphans.forEach {
      assertFalse("${it.name} survived the sweep", it.exists())
      assertFalse(w.logFilePaths().contains(it.absolutePath))
    }
  }

  /**
   * The finished bundle is NOT swept. It is something the caller asked for and
   * may not have uploaded yet; deleting it on the next rotation would make
   * [LogFileWriter.collectLogs] a race.
   */
  @Test
  fun `a finished bundle survives the retention sweep`() {
    val w = writer(
      LogRotationPolicy.of(maxFileSizeBytes = 64.0, maxArchivedFilesCount = 1.0)
    )
    w.write(line(0))
    w.flush(1, 1000.0)
    w.collectLogs(1, 5000.0, 10_000_000.0)
    assertTrue(bundle.exists())

    w.writeRotating(6)
    assertEquals(1, archiveNames().size)

    assertTrue(bundle.exists())
  }

  // MARK: - Deleting the bundle

  /**
   * The third step of the support flow, and the one that decides whether a
   * gzipped copy of the whole log stays on the device after the upload.
   */
  @Test
  fun `deleting the bundle removes it and leaves the logs alone`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 64.0))
    w.writeRotating(6)
    w.collectLogs(1, 5000.0, 10_000_000.0)
    assertTrue(bundle.exists())
    val logsBefore = w.logFilePaths()
    assertTrue("the setup did not produce archives to spare", logsBefore.size > 1)

    assertTrue(w.deleteSupportBundle(w.currentGeneration, 5000.0))

    assertFalse("it reported the bundle gone with the bundle still on disk", bundle.exists())
    // The half that makes this not a smaller purge. Deleting the copy must
    // leave every original exactly where it was.
    assertEquals("it deleted log files too", logsBefore, w.logFilePaths())
  }

  /**
   * Deleting a bundle that is not there is the outcome the caller asked for,
   * not a failure — a retry, and a collect that found nothing to pack, both
   * land here.
   */
  @Test
  fun `deleting a bundle that was never collected succeeds`() {
    val w = writer()
    w.write(line(0))
    w.flush(1, 1000.0)
    assertFalse(bundle.exists())

    assertTrue(w.deleteSupportBundle(w.currentGeneration, 5000.0))
  }

  /**
   * The staging names hold log bytes too — a half-written bundle and the
   * scratch file a plaintext source was being compressed into. Leaving either
   * behind would leave a partial copy of the log the caller believes it
   * deleted.
   */
  @Test
  fun `deleting takes the staging leftovers as well`() {
    val w = writer()
    w.write(line(0))
    w.flush(1, 1000.0)
    val leftovers = listOf(
      LogFileWriter.supportStagingName("app.log"),
      LogFileWriter.supportMemberName("app.log")
    ).map { File(directory, it) }
    leftovers.forEach { it.writeText("truncated") }

    assertTrue(w.deleteSupportBundle(w.currentGeneration, 5000.0))

    leftovers.forEach { assertFalse("${it.name} survived", it.exists()) }
  }

  /**
   * Being active is not the same as being current, and this is the difference.
   *
   * The generation below is never closed, so every liveness gate it passes says
   * yes; what it is not is the owner of that directory any more. A purge moved
   * the writer on, and the bundle sitting there was produced afterwards — and
   * has already been handed back to a caller as a path to upload. Deleting it
   * is the ownership violation this check exists for, and nothing about the
   * handle's own state would catch it.
   */
  @Test
  fun `a generation left behind by a purge cannot delete the bundle`() {
    val w = writer()
    val stale = w.currentGeneration
    w.write(line(0))
    w.flush(1, 1000.0)

    // The purge moves the writer on; the collect afterwards publishes a bundle
    // belonging to the new generation.
    assertTrue(w.clearLogs(5000.0).first.durable)
    val current = w.currentGeneration
    assertNotEquals("the purge did not move the generation", stale, current)
    w.append(1, current, line(1), 1)
    w.flush(1, 1000.0)
    assertTrue(w.collectLogs(1, 5000.0, 10_000_000.0).complete)
    assertTrue(bundle.exists())

    assertFalse(
      "a stale generation reported deleting a bundle it does not own",
      w.deleteSupportBundle(stale, 5000.0)
    )
    assertTrue("a stale generation deleted the current bundle", bundle.exists())

    // And the owner can still delete its own.
    assertTrue(w.deleteSupportBundle(current, 5000.0))
    assertFalse(bundle.exists())
  }

  /**
   * A delete that lands *before* a build publishes leaves a bundle behind, and
   * that is correct rather than a leak.
   *
   * `true` is a statement about the instant the call ran, not a promise about
   * the next one — the collect that was already in flight legitimately writes a
   * fresh bundle afterwards. Sequencing the two is the caller's job.
   *
   * The other half, and the reason this test is worth its length: the delete
   * whose bound expired must not run later. Queued behind the build, it would
   * otherwise reach the front of the executor after the publish and unlink the
   * bundle that collect just reported the path of. See
   * [LogFileWriter.DeleteRequest].
   */
  @Test
  fun `a bundle deleted before a publish is recreated by the collect`() {
    val held = CountDownLatch(1)
    val inCompressor = CountDownLatch(1)
    val compressor = LogFileWriter.Compressor { source, destination ->
      inCompressor.countDown()
      held.await()
      realGzip(source, destination)
    }
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0), compressor = compressor)
    w.write("precious\n")
    w.flush(1, 1000.0)
    // A bundle from an earlier collect, so the delete below has something real
    // to remove rather than succeeding vacuously.
    bundle.writeText("earlier")

    val collected = AtomicReference<LogCollectOutcome>()
    val collectThread = Thread { collected.set(w.collectLogs(1, 10_000.0, 10_000_000.0)) }
    try {
      collectThread.start()
      assertTrue(inCompressor.await(10, TimeUnit.SECONDS))
      releaseAfter(held, 3_000)

      // The build owns the executor, so this cannot run yet — the same
      // serialization `a purge cannot preempt a build already running` pins. It
      // is bounded, and a bound that expires is `false`.
      assertFalse(
        "it reported a deletion it never got the executor to perform",
        w.deleteSupportBundle(w.currentGeneration, 50.0)
      )
    } finally {
      held.countDown()
    }

    collectThread.join(10_000)
    assertTrue("the build was not preempted; it published", collected.get().complete)

    w.settleForTesting()
    assertTrue("the collect's own bundle went missing", bundle.exists())
    assertNotEquals(
      "the abandoned delete ran anyway and took the bundle the collect published",
      "earlier",
      bundle.readText()
    )
  }

  /** The ordinary support flow, with the delete last: nothing remains. */
  @Test
  fun `a bundle deleted after a publish is gone`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 64.0))
    w.writeRotating(6)
    val collected = w.collectLogs(1, 5000.0, 10_000_000.0)
    assertTrue(collected.complete)
    assertEquals(bundle.absolutePath, collected.path)

    assertTrue(w.deleteSupportBundle(w.currentGeneration, 5000.0))

    // Every support name, not just the published one: a staging file the build
    // left behind is a partial copy of the same log.
    assertEquals(
      "a support artifact survived the delete",
      emptyList<String>(),
      directory.list()!!.filter { it.startsWith("app.log.support") }
    )
  }

  // MARK: - The deadline

  /**
   * A collect the caller stopped waiting for must not publish afterwards.
   *
   * The build cannot be cancelled mid-copy — nothing cancels a queued task — so
   * the only thing that can be stopped is the rename. Without that barrier this
   * call reports "no bundle" and a complete copy of the whole log lands beside
   * the log seconds later: outside the retention budget the app configured,
   * invisible to `logFilePaths()`, and deliberately skipped by the orphan sweep
   * because a FINISHED bundle is one somebody may be about to upload.
   */
  @Test
  fun `a collect that overran publishes nothing`() {
    // Real gzip behind the sleep, so the build that overruns is a build that
    // would otherwise have succeeded — which is the only version of it that
    // could publish anything.
    val slow = LogFileWriter.Compressor { source, destination ->
      Thread.sleep(500)
      realGzip(source, destination)
    }
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0), compressor = slow)
    w.write("precious\n")
    w.flush(1, 1000.0)

    val outcome = w.collectLogs(1, 50.0, 10_000_000.0)
    assertFalse("the wait was 50ms and the build takes 500", outcome.complete)
    assertEquals("", outcome.path)

    // Let the build run to the end it would have reached anyway.
    w.settleForTesting()

    assertFalse("a bundle appeared for a collect that reported none", bundle.exists())
    assertEquals(
      "the abandoned build left its temporaries behind",
      emptyList<String>(),
      directory.list()!!.filter { it.startsWith("app.log.support") }
    )
  }

  /**
   * Two collects that both overran, and neither publishes.
   *
   * The interesting order is the second one: the first build is still copying
   * when the second collect gives up, so if "abandoned" were one flag on the
   * writer rather than one per collect, the second timeout would overwrite the
   * first — and the first build, arriving at its barrier last, would find
   * itself un-abandoned and publish a bundle for a call that reported none.
   */
  @Test
  fun `two overrun collects publish nothing`() {
    val slow = LogFileWriter.Compressor { source, destination ->
      Thread.sleep(500)
      realGzip(source, destination)
    }
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0), compressor = slow)
    w.write("precious\n")
    w.flush(1, 1000.0)

    // Both enqueue onto the one executor and both give up while the first is
    // still inside its compressor.
    val first = w.collectLogs(1, 50.0, 10_000_000.0)
    val second = w.collectLogs(1, 50.0, 10_000_000.0)
    assertFalse(first.complete)
    assertFalse(second.complete)

    w.settleForTesting()

    assertFalse("an abandoned build published anyway", bundle.exists())
    assertEquals(
      emptyList<String>(),
      directory.list()!!.filter { it.startsWith("app.log.support") }
    )
  }

  /**
   * One collect giving up must not poison the next one.
   *
   * The other half of keeping abandonment per collect. A flag on the writer
   * would be sticky: once anything had timed out, every later collect would
   * find itself abandoned at the barrier and this destination would never
   * produce a bundle again.
   */
  @Test
  fun `a collect after an overrun one still publishes`() {
    var slow = true
    val compressor = LogFileWriter.Compressor { source, destination ->
      if (slow) Thread.sleep(500)
      realGzip(source, destination)
    }
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0), compressor = compressor)
    w.write("precious\n")
    w.flush(1, 1000.0)

    assertFalse(w.collectLogs(1, 50.0, 10_000_000.0).complete)
    w.settleForTesting()
    assertFalse(bundle.exists())

    slow = false
    val outcome = w.collectLogs(1, 5000.0, 10_000_000.0)

    assertTrue("a timed-out collect disabled every one after it", outcome.complete)
    assertEquals("precious\n", gunzipAll(bundle))
  }

  // MARK: - Lifecycle

  /**
   * Records still in the queue when a collect starts have to be in it. A bundle
   * missing the last few seconds is missing the part somebody is asking about.
   */
  @Test
  fun `the bundle includes records that were still buffered`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0))
    // No flush and no settle: this one has to still be in flight.
    w.write("in flight\n")

    val outcome = w.collectLogs(1, 5000.0, 10_000_000.0)

    assertTrue(outcome.complete)
    assertEquals("in flight\n", gunzipAll(bundle))
  }

  @Test
  fun `a terminated writer collects nothing`() {
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0))
    w.write("precious\n")
    w.flush(1, 1000.0)
    w.close(1, 1000.0)

    val outcome = w.collectLogs(1, 5000.0, 10_000_000.0)

    assertEquals("", outcome.path)
    assertFalse(outcome.complete)
    assertFalse(bundle.exists())
  }

  private fun archiveNames(): List<String> =
    directory.list()!!.filter { LogFileWriter.isArchiveName(it, "app.log") }

  // MARK: - The publish barrier

  /*
   What the tests below do NOT prove.

   - **Not that the replace is atomic to an external reader.** Nothing here
     opens the bundle path while the rename runs. That property comes from
     `Os.rename`'s contract, and this suite takes it on the contract — and does
     not exercise `Os.rename` at all, since these run on [PlatformIo.Jvm].
   - **Not that two completed collects leave a caller's path meaningful.** There
     is one bundle name, so a later collect replaces an earlier one's file
     whether or not they overlapped. Inherent to the name; `collectLock` does
     not change it.
   - **Not that two builds cannot corrupt each other.** They cannot, but the
     single-threaded executor is what guarantees it, not `collectLock`. Removing
     the lock leaves the bundles intact and only wastes the executor — which is
     why the contention test asserts the compressor call count rather than the
     contents.
   */

  /**
   * **The headline fix.** A collect that produces no bundle must not destroy the
   * one that is already there.
   *
   * `buildBundle` used to delete the published bundle as its *first* action,
   * before it knew whether it would publish anything. Every failure after that
   * — abandoned by timeout, nothing selected, a member that would not copy, a
   * rename that failed — left the caller of an earlier successful collect
   * holding a path to a file that no longer existed, and no call ever reported
   * destroying it. A support flow that had collected, shown the user a size, and
   * was about to upload would find nothing there.
   *
   * Nothing pre-deletes now. The publish is a replacing rename, which does not
   * touch its destination unless it succeeds.
   */
  @Test
  fun `an overrun collect leaves the earlier bundle in place`() {
    var slow = false
    val compressor = LogFileWriter.Compressor { source, destination ->
      if (slow) Thread.sleep(500)
      realGzip(source, destination)
    }
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0), compressor = compressor)
    w.write("precious\n")
    w.flush(1, 1000.0)

    val first = w.collectLogs(1, 5000.0, 10_000_000.0)
    assertTrue("the setup collect has to succeed for this to test anything", first.complete)
    assertEquals("precious\n", gunzipAll(bundle))

    // Now one that cannot finish inside its deadline.
    slow = true
    val second = w.collectLogs(1, 50.0, 10_000_000.0)
    assertFalse("the wait was 50ms and the build takes 500", second.complete)

    // Let the abandoned build run to the end it would have reached anyway; the
    // barrier stops it publishing, and it must not have destroyed anything on
    // the way either.
    w.settleForTesting()

    assertEquals(
      "a collect that published nothing deleted the bundle a previous one published",
      "precious\n",
      gunzipAll(bundle)
    )
    assertEquals(
      "the path the first caller is still holding is the one that survived",
      bundle.absolutePath,
      first.path
    )
  }

  /**
   * A collect refused for contention must not queue a build behind the winner.
   *
   * Two observables, because the two ways of getting this wrong look identical
   * from a single one. A *blocking* acquire is caught by the elapsed time: the
   * loser would sit until the winner released. *No lock at all* is caught by the
   * compressor call count: the loser would flush and enqueue a second full copy
   * of the log, and the count would be two.
   */
  @Test
  fun `a concurrent collect is refused rather than queued`() {
    val held = CountDownLatch(1)
    val inCompressor = CountDownLatch(1)
    val calls = AtomicInteger()
    val compressor = LogFileWriter.Compressor { source, destination ->
      calls.incrementAndGet()
      inCompressor.countDown()
      held.await()
      realGzip(source, destination)
    }
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0), compressor = compressor)
    w.write("precious\n")
    w.flush(1, 1000.0)

    val winner = AtomicReference<LogCollectOutcome>()
    val winnerThread = Thread { winner.set(w.collectLogs(1, 10_000.0, 10_000_000.0)) }
    try {
      winnerThread.start()
      // The winner's build is now provably inside the compressor, holding both
      // the executor and the collect gate. No sleep, no guessing.
      assertTrue(inCompressor.await(10, TimeUnit.SECONDS))
      releaseAfter(held, 3_000)

      // A different handle id — two destinations on ONE writer, which a
      // per-handle flag cannot see. That is why the lock lives on the writer.
      val began = System.nanoTime()
      val loser = w.collectLogs(2, 100.0, 10_000_000.0)
      val elapsedMs = (System.nanoTime() - began) / 1_000_000

      assertFalse(loser.complete)
      assertEquals("", loser.path)
      assertTrue(
        "the refused collect waited for the winner instead of giving up on its own deadline",
        elapsedMs < 2_000
      )
    } finally {
      held.countDown()
    }

    winnerThread.join(10_000)
    assertTrue("the winner should have published", winner.get().complete)
    w.settleForTesting()

    assertEquals(
      "the refused collect enqueued a build of its own — the point is that it does not",
      1,
      calls.get()
    )
  }

  /**
   * Cross-operation ordering, stated exactly: **a purge cannot preempt a build
   * that is already running**, and the executor is what guarantees it.
   *
   * The publish and the sweep are each a single executor task, so their mutating
   * phases cannot interleave. What that buys, and what it does not:
   *
   * - A purge submitted behind a running build waits for it. If its own deadline
   *   expires first it reports non-durable — truthfully, because it has deleted
   *   nothing yet — and then runs when the executor frees.
   * - It does **not** mean a purge cannot land between a collect's flush and its
   *   build. It can, and then the build reads a directory the purge emptied.
   *   That is a legitimate linearization, not a defect.
   */
  @Test
  fun `a purge cannot preempt a build already running`() {
    val held = CountDownLatch(1)
    val inCompressor = CountDownLatch(1)
    val compressor = LogFileWriter.Compressor { source, destination ->
      inCompressor.countDown()
      held.await()
      realGzip(source, destination)
    }
    val w = writer(LogRotationPolicy.of(maxFileSizeBytes = 10_000_000.0), compressor = compressor)
    w.write("precious\n")
    w.flush(1, 1000.0)

    val collected = AtomicReference<LogCollectOutcome>()
    val collectThread = Thread { collected.set(w.collectLogs(1, 10_000.0, 10_000_000.0)) }
    try {
      collectThread.start()
      assertTrue(inCompressor.await(10, TimeUnit.SECONDS))
      releaseAfter(held, 3_000)

      // The sweep cannot start: the build owns the executor.
      val purge = w.clearLogs(50.0).first
      assertFalse(
        "a purge that has not run a single unlink reported a durable deletion",
        purge.durable
      )
      assertEquals(
        "and it names what it did not delete",
        listOf(File(directory, "app.log").absolutePath),
        purge.failedPaths
      )
    } finally {
      held.countDown()
    }

    collectThread.join(10_000)
    assertTrue("the build was not preempted; it published", collected.get().complete)

    // Now let the queued sweep run. It was never cancelled — only late.
    w.settleForTesting()
    assertEquals(
      "the purge ran once the build let go of the executor, and took the bundle with it",
      emptyList<String>(),
      directory.list()!!.filter { it.startsWith("app.log.support") }
    )
  }

  /**
   * The seam the publish rests on, tested directly rather than only through a
   * collect.
   *
   * Both halves of [PlatformIo.renameReplacing]'s contract are load-bearing and
   * `File.renameTo` promises neither, which is why the seam exists at all. The
   * first is what removes the pre-delete; the second is what makes a failed
   * publish harmless.
   *
   * What this does not prove: anything about [AndroidPlatformIo]. It runs
   * `Files.move`, not `Os.rename`, because that is what the unit-test platform
   * is — the device implementation is covered only by the instrumented job.
   */
  @Test
  fun `renameReplacing replaces its destination and leaves it alone on failure`() {
    val from = File(directory, "source").apply { writeText("new\n") }
    val onto = File(directory, "destination").apply { writeText("old\n") }

    assertTrue(PlatformIo.Jvm.renameReplacing(from, onto))
    assertEquals("an existing destination was not replaced", "new\n", onto.readText())
    assertFalse("the source survived its own rename", from.exists())

    // Now one that cannot succeed: nothing to move.
    val missing = File(directory, "absent")
    assertFalse(PlatformIo.Jvm.renameReplacing(missing, onto))
    assertEquals(
      "a failed rename destroyed the destination it could not replace",
      "new\n",
      onto.readText()
    )
  }

  /**
   * Opens [latch] from a daemon thread after [millis].
   *
   * Insurance against the mutation, not against the code. Each test above gates
   * the writer and then does bounded work on the test thread — but if a bound
   * under test were removed, the test thread would block before reaching its own
   * `countDown()` and the suite would hang instead of reporting a failure. A
   * wedged run says far less than a red one, and it says it much later. This
   * fires long after the assertions in a passing run and changes nothing there.
   */
  private fun releaseAfter(latch: CountDownLatch, millis: Long) {
    Thread {
      Thread.sleep(millis)
      latch.countDown()
    }.apply { isDaemon = true }.start()
  }
}
