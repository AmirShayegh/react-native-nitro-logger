package com.margelo.nitro.nitrologger

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * [FileSinkAnswers] on everything the shared row table cannot ask.
 *
 * The table covers the nine spec ops in the two states that produce no handle,
 * and [FileSinkLifecycleRowsTest] drives it against this same object. What is
 * left — and what is here — is the open path, the refusal messages, the
 * argument guards, and the one lifecycle state the table deliberately does not
 * carry: a sink whose `open` threw.
 *
 * That third state matters more than its size suggests. The two table modes
 * cannot distinguish `snapshot()` from `artifactSource()` as the source of
 * [FileSinkAnswers.deleteSupportBundle]'s answer — a never-opened sink has
 * neither a handle nor a path, and an opened-then-closed sink has a path and
 * `created`, so both readings agree in both modes. The bug that shipped was
 * exactly that substitution, and only a half-failed open tells them apart. See
 * `a sink whose open failed before resolution cannot vouch for anything`, which
 * is the Kotlin twin of the iOS test of the same name.
 */
class FileSinkAnswersTest {
  private lateinit var directory: File
  private lateinit var registry: LogWriterRegistry

  @Before
  fun setUp() {
    directory = File.createTempFile("nitro-answers", "").let {
      it.delete()
      File(it.absolutePath + "-dir").apply { mkdirs() }
    }
    registry = LogWriterRegistry.isolated()
  }

  @After
  fun tearDown() {
    directory.deleteRecursively()
  }

  private fun answers() =
    FileSinkAnswers(registry = registry, platform = PlatformIo.Jvm, owner = null)

  private fun logPath(name: String = "app.log") = File(directory, name).absolutePath

  // MARK: the default directory

  @Test
  fun `the default directory is logs under the base it was given`() {
    val base = File(directory, "no-backup").apply { mkdirs() }
    assertEquals(File(base, "logs").absolutePath, answers().defaultLogDirectory(base))
  }

  @Test
  fun `a missing context falls back to a writable directory rather than failing`() {
    // Every JVM test and any host that has not installed the module reaches
    // this. It must be a real, writable path — a sink that could not resolve a
    // default at all would fail at construction rather than at open, where the
    // caller can see why.
    val fallback = File(answers().defaultLogDirectory(null))
    assertEquals("logs", fallback.name)
    assertTrue("the fallback parent must exist", fallback.parentFile.isDirectory)
    assertTrue("the fallback parent must be writable", fallback.parentFile.canWrite())
  }

  // MARK: refusing a second open

  @Test
  fun `a second open is refused as already open`() {
    val sink = answers()
    sink.open(logPath(), LogRotationPolicy.of(), true)
    try {
      sink.open(logPath(), LogRotationPolicy.of(), true)
      fail("a second open on a live sink must be refused")
    } catch (e: LogWriterException) {
      assertEquals(FileSinkMessages.ALREADY_OPEN, e.message)
      assertEquals(LogWriterException.Kind.CONFIG_CONFLICT, e.kind)
    } finally {
      sink.close(1000.0)
    }
  }

  @Test
  fun `an open after close is allowed`() {
    // Closed is not disposed. A destination that purges and rebinds opens the
    // same object again, and refusing that would end the sink at its first
    // compliance purge.
    val sink = answers()
    sink.open(logPath(), LogRotationPolicy.of(), true)
    sink.close(1000.0)

    sink.open(logPath(), LogRotationPolicy.of(), true)
    sink.close(1000.0)
  }

  @Test
  fun `a disposed sink refuses to open`() {
    val sink = answers()
    sink.releaseHandle()
    try {
      sink.open(logPath(), LogRotationPolicy.of(), true)
      fail("a disposed sink must not reopen")
    } catch (e: LogWriterException) {
      assertEquals(FileSinkMessages.DISPOSED, e.message)
    }
  }

  // MARK: the failure mapper

  @Test
  fun `the failure mapper is on the open path`() {
    // A second sink on the same path with a different configuration is the one
    // acquisition failure this target can stage directly, and it is enough to
    // prove `open` routes its throw through `FileSinkMessages` rather than
    // letting the raw throwable's text out. `FileSinkMessagesTest` drives the
    // mapper's own arms.
    val first = answers()
    first.open(logPath(), LogRotationPolicy.of(), true)
    try {
      val second = answers()
      try {
        second.open(logPath(), LogRotationPolicy.of(), false)
        fail("a conflicting configuration must be refused")
      } catch (e: LogWriterException) {
        assertEquals(FileSinkMessages.CONFIG_CONFLICT, e.message)
      }
    } finally {
      first.close(1000.0)
    }
  }

  /**
   * A failed open forfeits vacuous success, and does not get it back.
   *
   * This is the state the shared table cannot carry, and the only one that
   * distinguishes the two readings of "is my bundle gone". `acquire` creates
   * the log directory before it opens the file, so a throw is not evidence that
   * nothing was written — and a `deleteSupportBundle` that answered from
   * `artifactSource()` would say `true` here, over a directory it had just
   * made, and delete the caller's obligation to retry.
   *
   * The failure has to land *before* `onResolve`, which is what makes this the
   * distinguishing case: resolution throwing leaves `openedPath` null while
   * `beginOpen` has already set `created`. A config conflict would not do — it
   * is raised after resolution, so both readings answer alike.
   */
  @Test
  fun `a sink whose open failed before resolution cannot vouch for anything`() {
    // A path whose parent is a regular file cannot be resolved into a
    // directory, and the attempt fails before any canonical name exists.
    val blocker = File(directory, "blocker")
    blocker.writeText("not a directory")
    val sink = answers()
    try {
      sink.open(File(blocker, "app.log").absolutePath, LogRotationPolicy.of(), true)
      fail("a log path under a regular file must not open")
    } catch (e: LogWriterException) {
      assertNotNull(e.message)
    }

    // Nothing resolved, so there is no path to enumerate — and that is exactly
    // why `deleteSupportBundle` must not answer from `artifactSource()`.
    assertEquals(emptyList<String>(), sink.getLogFilePaths())

    assertFalse(
      "no path recorded is not the same as nothing to delete",
      sink.deleteSupportBundle(1000.0)
    )
    assertFalse(sink.clearLogs(1000.0).durable)
    assertFalse(sink.flush(1000.0).durable)
    assertFalse(sink.close(1000.0).durable)
  }

  // MARK: arguments

  @Test
  fun `a non-integral entry count is refused rather than rounded`() {
    val sink = answers()
    sink.open(logPath(), LogRotationPolicy.of(), true)
    try {
      // A count that does not survive the round trip cannot be trusted to
      // describe the batch it arrived with. See [BridgeNumber.exactLong].
      for (hostile in listOf(
        Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, 1e30, 1.5
      )) {
        val result = sink.appendBatch("{\"m\":1}\n", hostile)
        assertFalse("entryCount $hostile was accepted", result.accepted)
        assertEquals(WireRejectReason.FAILED, result.rejectReason)
      }

      // And the batch really was refused, not merely reported as refused.
      assertTrue(sink.flush(1000.0).durable)
      assertEquals(0.0, sink.getStatus().queuedBytes, 0.0)
    } finally {
      sink.close(1000.0)
    }
  }

  @Test
  fun `an absent lineFramed flag is absent rather than true`() {
    // Without a declared one-record-per-line contract the startup scan must not
    // trim a trailing record: it cannot tell a torn one from an intentional
    // newline. Null therefore has to reach the registry as `false`, and a sink
    // that defaulted it to `true` would silently discard a caller's last line
    // on the next open.
    val sink = answers()
    sink.open(logPath(), LogRotationPolicy.of(), null)
    try {
      // A second sink declaring `false` agrees with the first; declaring `true`
      // is a configuration conflict. That is the only observable difference,
      // and it is the registry's own definition of the flag.
      val agreeing = answers()
      agreeing.open(logPath(), LogRotationPolicy.of(), false)
      agreeing.close(1000.0)

      val disagreeing = answers()
      try {
        disagreeing.open(logPath(), LogRotationPolicy.of(), true)
        fail("declaring lineFramed against a sink opened without it must conflict")
      } catch (e: LogWriterException) {
        assertEquals(FileSinkMessages.CONFIG_CONFLICT, e.message)
      }
    } finally {
      sink.close(1000.0)
    }
  }

  // MARK: with a live handle

  @Test
  fun `a live sink delegates every op to its handle`() {
    val sink = answers()
    sink.open(logPath(), LogRotationPolicy.of(), true)
    try {
      val accepted = sink.appendBatch("{\"m\":1}\n", 1.0)
      assertTrue(accepted.accepted)
      assertNull(accepted.rejectReason)

      assertTrue(sink.flush(1000.0).durable)
      // The bytes are on disk, which is what makes the rest of this test about
      // the handle rather than about an empty directory.
      //
      // The canonical path, because that is what the registry resolved and
      // recorded: on macOS the JVM temp directory is under `/var`, which is a
      // symlink to `/private/var`. Comparing against the spelling this test
      // passed in would fail there and pass on the Linux runner, which is the
      // worse of the two outcomes.
      assertEquals(listOf(File(logPath()).canonicalPath), sink.getLogFilePaths())

      val collected = sink.collectLogs(1000.0, 1_000_000.0)
      assertTrue(collected.complete)
      assertTrue(collected.byteCount > 0.0)
      assertEquals(1.0, collected.sourceFileCount, 0.0)
      assertTrue(sink.deleteSupportBundle(1000.0))

      // A live purge really deletes and really rebinds — the two facts the JS
      // destination reads separately before it resumes.
      val cleared = sink.clearLogs(1000.0)
      assertTrue(cleared.durable)
      assertTrue(cleared.rebound)
      assertEquals(emptyList<String>(), cleared.failedPaths)
      assertTrue(cleared.deletedCount > 0.0)

      // Zeroed after a purge, not stale: this is the status a live handle
      // reports, and it comes from the handle rather than from the no-handle
      // constant, which `maintain` on a live sink also has to.
      assertEquals(WireSinkStatus(0.0, 0.0, 0.0, 0.0), sink.maintain(1000.0))
    } finally {
      sink.close(1000.0)
    }
  }

  @Test
  fun `releaseHandle frees the registry slot and is terminal`() {
    val sink = answers()
    sink.open(logPath(), LogRotationPolicy.of(), true)
    sink.releaseHandle()

    // The slot is free: another sink can take the same path, which it could not
    // do while the first still held it with a different configuration.
    val next = answers()
    next.open(logPath(), LogRotationPolicy.of(), false)
    next.close(1000.0)

    // And the disposed one stays disposed rather than becoming reusable.
    try {
      sink.open(logPath(), LogRotationPolicy.of(), true)
      fail("a released sink must not reopen")
    } catch (e: LogWriterException) {
      assertEquals(FileSinkMessages.DISPOSED, e.message)
    }
  }
}
