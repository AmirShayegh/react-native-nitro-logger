package com.margelo.nitro.nitrologger

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The Kotlin half of the pair. Same table, same rows, same order as
 * `FileSinkLifecycleTests.swift` — the point of extracting the rules was that
 * one contract stops having two implementations, so the two suites are meant
 * to be read side by side.
 */
class FileSinkLifecycleTest {
  private lateinit var directory: File
  private lateinit var registry: LogWriterRegistry
  private val handles = mutableListOf<LogFileHandle>()

  @Before
  fun setUp() {
    directory = File.createTempFile("nitro-lifecycle-test", "").let {
      it.delete()
      File(it.absolutePath + "-dir").apply { mkdirs() }
    }
    registry = LogWriterRegistry.isolated()
  }

  @After
  fun tearDown() {
    handles.forEach { runCatching { it.close(500.0) } }
    handles.clear()
    directory.deleteRecursively()
  }

  private fun handle(name: String = "app.log"): LogFileHandle = registry.acquire(
    path = File(directory, name).absolutePath,
    policy = LogRotationPolicy.of(),
    lineFramed = true,
    platform = PlatformIo.Jvm,
    clock = { 1_700_000_000_000L }
  ).also { handles.add(it) }

  // MARK: never opened

  @Test
  fun `a fresh sink is idle and can claim success vacuously`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.State.IDLE, lifecycle.currentState)
    assertNull(lifecycle.current())
    assertTrue(lifecycle.vacuousSuccess)
  }

  /**
   * Set before the attempt, not after it succeeds: `acquire` creates the log
   * directory and can then fail on the file, so a throw is not evidence that
   * nothing was written.
   */
  @Test
  fun `claiming the right to open immediately forfeits vacuous success`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())

    assertEquals(FileSinkLifecycle.State.OPENING, lifecycle.currentState)
    assertFalse(lifecycle.vacuousSuccess)
  }

  // MARK: refusing a second open

  @Test
  fun `a second open is refused while the first is still acquiring`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())

    // The loser's handle would be unreachable, and unreachable means a later
    // purge never deletes its files.
    assertEquals(FileSinkLifecycle.Claim.ALREADY_OPEN, lifecycle.beginOpen())
    assertEquals(FileSinkLifecycle.State.OPENING, lifecycle.currentState)
  }

  @Test
  fun `a second open is refused once a handle is installed`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    assertEquals(FileSinkLifecycle.Installation.INSTALLED, lifecycle.finishOpen(handle()))

    assertEquals(FileSinkLifecycle.State.OPEN, lifecycle.currentState)
    assertEquals(FileSinkLifecycle.Claim.ALREADY_OPEN, lifecycle.beginOpen())
  }

  // MARK: open failure

  @Test
  fun `a failed open returns to closed without regaining vacuous success`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.failOpen()

    assertEquals(FileSinkLifecycle.State.CLOSED, lifecycle.currentState)
    assertFalse(lifecycle.vacuousSuccess)
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
  }

  // MARK: close

  @Test
  fun `closing hands the handle back exactly once`() {
    val lifecycle = FileSinkLifecycle()
    val live = handle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    assertEquals(FileSinkLifecycle.Installation.INSTALLED, lifecycle.finishOpen(live))

    assertSame(live, lifecycle.beginClose().handle)
    assertEquals(FileSinkLifecycle.State.CLOSED, lifecycle.currentState)
    assertNull(lifecycle.beginClose().handle)
    assertNull(lifecycle.current())
  }

  @Test
  fun `closing never restores vacuous success`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.finishOpen(handle())
    lifecycle.beginClose()

    assertFalse(lifecycle.vacuousSuccess)
  }

  @Test
  fun `a closed sink can be opened again`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.finishOpen(handle())
    lifecycle.beginClose()

    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
  }

  // MARK: where the artifacts are

  @Test
  fun `a closed sink still knows where its artifacts are`() {
    val lifecycle = FileSinkLifecycle()
    val live = handle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    assertEquals(FileSinkLifecycle.Installation.INSTALLED, lifecycle.finishOpen(live))
    lifecycle.beginClose()

    val source = lifecycle.artifactSource()
    assertNull("the handle went out with the close", source.handle)
    assertEquals(
      "closing releases a handle; it does not unmake files, and the caller collecting them needs the name",
      live.filePath,
      source.path
    )
  }

  /**
   * The writer's path wins over the caller's spelling of it.
   *
   * The registry canonicalizes what it is handed — `/var` resolves through to
   * `/private/var` on the machine this suite runs on, and a relative path or a
   * symlinked ancestor resolves the same way — and the artifacts are under
   * *that* name. Enumerating the caller's string after a close would follow a
   * symlink that may since have been retargeted and hand a support upload
   * somebody else's directory.
   */
  @Test
  fun `the artifact source is the writer's resolved path, not the caller's`() {
    val lifecycle = FileSinkLifecycle()
    val asked = File(directory, "./nested/../app.log").absolutePath
    val live = handle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.finishOpen(live)

    assertNotEquals("the spellings have to differ or this proves nothing",
                    asked, live.filePath)
    assertEquals(live.filePath, lifecycle.artifactSource().path)
    lifecycle.beginClose()
    assertEquals("and it survives the close", live.filePath, lifecycle.artifactSource().path)
  }

  /**
   * An open still in flight has nothing to enumerate, and says so.
   *
   * There is no canonical name yet — the directory may not exist to resolve
   * through — and the caller's spelling is not an acceptable stand-in. Nothing
   * has been accepted through this sink at this point either, so `[]` is the
   * true answer rather than a cautious one.
   */
  @Test
  fun `an open still in flight has nothing to enumerate`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())

    assertNull(lifecycle.artifactSource().path)
    assertFalse("but it has already forfeited vacuous success", lifecycle.vacuousSuccess)
  }

  @Test
  fun `a sink that never opened has nowhere to look`() {
    val lifecycle = FileSinkLifecycle()
    val source = lifecycle.artifactSource()
    assertNull(source.handle)
    assertNull("nowhere to look, which is not the same as nothing to find", source.path)
  }

  /**
   * Same reasoning as `created`: a failed acquisition may still have created
   * the directory, so what it left stays enumerable.
   *
   * The path recorded is the one the acquire **reported as it resolved**, not
   * one looked up afterwards — and the difference is the whole point. This
   * walks the adapter's own sequence: capture the report, let the acquire die,
   * record the capture. The symlink is retargeted from inside the report, which
   * is exactly the interval a re-resolution after the failure would run in, so
   * a second lookup would answer `elsewhere` and the assertion below says it
   * does not.
   */
  @Test
  fun `a failed open records the path the acquire resolved, not a later lookup`() {
    val real = File(directory, "real").apply { mkdirs() }
    val elsewhere = File(directory, "elsewhere").apply { mkdirs() }
    val link = File(directory, "link")
    // Assumed, not returned from. A bare `return` reports green for a test that
    // never ran its own invariant; a skip is caught by `check-test-reports.sh`,
    // which counts one as a hole rather than a pass.
    Assume.assumeTrue(
      "this filesystem makes symbolic links",
      runCatching {
        java.nio.file.Files.createSymbolicLink(link.toPath(), real.toPath())
      }.isSuccess
    )
    val asked = File(link, "app.log").absolutePath

    // A live writer on the resolved path, so the second acquire fails *after*
    // resolution — the only failures that have a resolved path to report.
    handle("link/app.log")

    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    var reported: String? = null
    var retarget = Result.success(Unit)
    try {
      registry.acquire(
        path = asked,
        policy = LogRotationPolicy.of(),
        // Disagrees with the live writer's, which is what makes it throw.
        lineFramed = false,
        platform = PlatformIo.Jvm,
        onResolve = {
          reported = it
          // Between resolution and the failure. Everything after this point
          // sees a link pointing somewhere the acquire never touched.
          retarget = runCatching {
            link.delete()
            java.nio.file.Files.createSymbolicLink(link.toPath(), elsewhere.toPath())
            Unit
          }
        }
      )
      fail("expected the conflicting configuration to be refused")
    } catch (e: LogWriterException) {
      assertEquals(LogWriterException.Kind.CONFIG_CONFLICT, e.kind)
      lifecycle.failOpen(reported)
    }

    // The window has to have actually moved. If the retarget quietly failed, a
    // second lookup would land on `real` as well and every assertion below
    // would hold for a build that re-resolves — green, and proving nothing.
    assertTrue("the retarget failed: ${retarget.exceptionOrNull()}", retarget.isSuccess)
    assertEquals("the link has to point somewhere else now",
                 elsewhere.canonicalFile.absolutePath, link.canonicalFile.absolutePath)
    assertNotEquals("the spellings have to differ or this proves nothing",
                    asked, reported)
    assertEquals(
      "the acquire resolved through the link as it was, and that is what is kept",
      File(real.canonicalFile, "app.log").absolutePath,
      lifecycle.artifactSource().path
    )
    assertFalse(
      "a lookup after the failure would have followed the retargeted link",
      lifecycle.artifactSource().path!!.startsWith(elsewhere.canonicalFile.absolutePath)
    )
  }

  /**
   * A failure before resolution leaves nothing recorded.
   *
   * Not a fallback to the caller's string: resolution is what creates the
   * directory, so a failure ahead of it left nothing on disk — and keeping an
   * unresolved name is the one thing that lets a symlink created later decide
   * what a support upload enumerates.
   */
  @Test
  fun `a failure before resolution records nothing`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())

    var reported: String? = null
    try {
      registry.acquire(
        // Refused by `resolve`'s first line, before it creates anything.
        path = "",
        policy = LogRotationPolicy.of(),
        lineFramed = true,
        platform = PlatformIo.Jvm,
        onResolve = { reported = it }
      )
      fail("expected the open to be refused")
    } catch (e: LogWriterException) {
      assertEquals(LogWriterException.Kind.OPEN_FAILED, e.kind)
    }
    assertNull("resolution never produced a path, so none was reported", reported)
    lifecycle.failOpen(reported)

    assertNull(lifecycle.artifactSource().path)
  }

  // MARK: close racing open

  @Test
  fun `a close arriving during acquisition cancels the open`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())

    assertNull(lifecycle.beginClose().handle)
    assertEquals(FileSinkLifecycle.State.CLOSE_PENDING, lifecycle.currentState)

    assertEquals(FileSinkLifecycle.Installation.ABANDON, lifecycle.finishOpen(handle()))
    assertEquals(FileSinkLifecycle.State.CLOSED, lifecycle.currentState)
    assertNull(lifecycle.current())
  }

  @Test
  fun `a cancelled open does not cancel the one after it`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.beginClose()
    assertEquals(FileSinkLifecycle.Installation.ABANDON, lifecycle.finishOpen(handle()))

    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    val second = handle("second.log")
    assertEquals(FileSinkLifecycle.Installation.INSTALLED, lifecycle.finishOpen(second))
    assertSame(second, lifecycle.current())
  }

  /**
   * A *second* close before the acquisition lands must not free the sink.
   *
   * If the second close moved the state on to CLOSED, a new open could start
   * while the first acquisition was still in flight — and that acquisition,
   * landing into the new open's OPENING state, would install ITS handle. The
   * caller that asked for the second path would be handed a sink pointing at
   * the first, with its own handle abandoned: a writer for the wrong file,
   * under the wrong rotation policy, and no error anywhere. Closing twice is
   * ordinary — JavaScript can, and `dispose` does — so the cancellation has to
   * survive being repeated.
   */
  @Test
  fun `a second close during acquisition does not free the sink`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())

    assertNull(lifecycle.beginClose().handle)
    assertNull(lifecycle.beginClose().handle)
    assertEquals(FileSinkLifecycle.State.CLOSE_PENDING, lifecycle.currentState)
    assertEquals(FileSinkLifecycle.Claim.CLOSING, lifecycle.beginOpen())

    // The first acquisition finally lands, and is still discarded.
    val stale = handle()
    assertEquals(FileSinkLifecycle.Installation.ABANDON, lifecycle.finishOpen(stale))
    assertNull(lifecycle.current())

    // Only now is the sink free, and the next open gets its own handle.
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    val fresh = handle("fresh.log")
    assertEquals(FileSinkLifecycle.Installation.INSTALLED, lifecycle.finishOpen(fresh))
    assertSame(fresh, lifecycle.current())
  }

  /**
   * Disposing after an ordinary close, both during acquisition, still ends
   * terminal — the repeat-close rule must not swallow the dispose.
   */
  @Test
  fun `disposing after a close during acquisition is still terminal`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    assertNull(lifecycle.beginClose().handle)

    assertNull(lifecycle.beginDispose().handle)
    assertEquals(FileSinkLifecycle.State.DISPOSED, lifecycle.currentState)
    assertEquals(FileSinkLifecycle.Installation.ABANDON, lifecycle.finishOpen(handle()))
    assertEquals(FileSinkLifecycle.Claim.DISPOSED, lifecycle.beginOpen())
  }

  @Test
  fun `an open is refused while a cancelled acquisition is still in flight`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.beginClose()

    assertEquals(FileSinkLifecycle.State.CLOSE_PENDING, lifecycle.currentState)
    assertEquals(FileSinkLifecycle.Claim.CLOSING, lifecycle.beginOpen())
  }

  // MARK: dispose

  @Test
  fun `dispose is terminal where close is not`() {
    val lifecycle = FileSinkLifecycle()
    val live = handle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.finishOpen(live)

    assertSame(live, lifecycle.beginDispose().handle)
    assertEquals(FileSinkLifecycle.State.DISPOSED, lifecycle.currentState)
    assertEquals(FileSinkLifecycle.Claim.DISPOSED, lifecycle.beginOpen())
  }

  @Test
  fun `disposing during acquisition also discards the handle`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())

    assertNull(lifecycle.beginDispose().handle)
    assertEquals(FileSinkLifecycle.Installation.ABANDON, lifecycle.finishOpen(handle()))
    assertEquals(FileSinkLifecycle.State.DISPOSED, lifecycle.currentState)
  }

  @Test
  fun `disposing twice is harmless`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.finishOpen(handle())

    assertSame(handles.first(), lifecycle.beginDispose().handle)
    assertNull(lifecycle.beginDispose().handle)
    assertEquals(FileSinkLifecycle.State.DISPOSED, lifecycle.currentState)
  }

  // MARK: the pair that must be read together

  /**
   * "No handle, and nothing was ever created" is the one combination that is
   * never true after an open, and the one that reports a durable purge over
   * surviving files.
   *
   * This is the assertion the review said did not exist: reverting
   * `durable = !mayHaveArtifacts` used to leave every test in the repo green.
   */
  @Test
  fun `a closed sink refuses to call a purge durable`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.finishOpen(handle())
    lifecycle.beginClose()

    val snapshot = lifecycle.snapshot()
    assertNull(snapshot.handle)
    assertFalse(snapshot.durableWithoutHandle)
  }

  @Test
  fun `a never opened sink calls a purge durable vacuously`() {
    val snapshot = FileSinkLifecycle().snapshot()
    assertNull(snapshot.handle)
    assertTrue(snapshot.durableWithoutHandle)
  }

  /**
   * A purge over a sink whose open *failed* is not durable either: `acquire`
   * creates the directory before it opens the file.
   */
  @Test
  fun `a sink whose open failed refuses to call a purge durable`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.failOpen()

    assertFalse(lifecycle.snapshot().durableWithoutHandle)
  }

  // MARK: concurrency

  /**
   * Two winners means two writers on one file, and the loser's handle is
   * unreachable — so a later purge never deletes its files.
   */
  @Test
  fun `exactly one of many concurrent opens wins`() {
    val lifecycle = FileSinkLifecycle()
    val winners = AtomicInteger()

    runConcurrently(64) { if (lifecycle.beginOpen() == FileSinkLifecycle.Claim.GRANTED) winners.incrementAndGet() }

    assertEquals(1, winners.get())
    assertEquals(FileSinkLifecycle.State.OPENING, lifecycle.currentState)
  }

  /**
   * Handing the same handle to two callers means two closes on one writer, the
   * second against a registry slot somebody else already gave back.
   */
  @Test
  fun `concurrent closes hand the handle to exactly one caller`() {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    lifecycle.finishOpen(handle())

    val takers = AtomicInteger()
    runConcurrently(64) { index ->
      val taken = if (index % 2 == 0) lifecycle.beginClose().handle else lifecycle.beginDispose().handle
      if (taken != null) takers.incrementAndGet()
    }

    assertEquals(1, takers.get())
    assertNull(lifecycle.current())
  }

  /** Releases every thread at once, so the calls genuinely overlap. */
  private fun runConcurrently(count: Int, body: (Int) -> Unit) {
    val pool = Executors.newFixedThreadPool(minOf(count, 16))
    val start = CountDownLatch(1)
    val done = CountDownLatch(count)
    repeat(count) { index ->
      pool.execute {
        start.await()
        try {
          body(index)
        } finally {
          done.countDown()
        }
      }
    }
    start.countDown()
    assertTrue("the concurrent phase did not finish", done.await(30, TimeUnit.SECONDS))
    pool.shutdown()
  }
}
