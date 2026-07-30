package com.margelo.nitro.nitrologger

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
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
    assertTrue(lifecycle.beginOpen())

    assertEquals(FileSinkLifecycle.State.OPENING, lifecycle.currentState)
    assertFalse(lifecycle.vacuousSuccess)
  }

  // MARK: refusing a second open

  @Test
  fun `a second open is refused while the first is still acquiring`() {
    val lifecycle = FileSinkLifecycle()
    assertTrue(lifecycle.beginOpen())

    // The loser's handle would be unreachable, and unreachable means a later
    // purge never deletes its files.
    assertFalse(lifecycle.beginOpen())
    assertEquals(FileSinkLifecycle.State.OPENING, lifecycle.currentState)
  }

  @Test
  fun `a second open is refused once a handle is installed`() {
    val lifecycle = FileSinkLifecycle()
    assertTrue(lifecycle.beginOpen())
    assertEquals(FileSinkLifecycle.Installation.INSTALLED, lifecycle.finishOpen(handle()))

    assertEquals(FileSinkLifecycle.State.OPEN, lifecycle.currentState)
    assertFalse(lifecycle.beginOpen())
  }

  // MARK: open failure

  @Test
  fun `a failed open returns to closed without regaining vacuous success`() {
    val lifecycle = FileSinkLifecycle()
    assertTrue(lifecycle.beginOpen())
    lifecycle.failOpen()

    assertEquals(FileSinkLifecycle.State.CLOSED, lifecycle.currentState)
    assertFalse(lifecycle.vacuousSuccess)
    assertTrue(lifecycle.beginOpen())
  }

  // MARK: close

  @Test
  fun `closing hands the handle back exactly once`() {
    val lifecycle = FileSinkLifecycle()
    val live = handle()
    assertTrue(lifecycle.beginOpen())
    assertEquals(FileSinkLifecycle.Installation.INSTALLED, lifecycle.finishOpen(live))

    assertSame(live, lifecycle.beginClose().handle)
    assertEquals(FileSinkLifecycle.State.CLOSED, lifecycle.currentState)
    assertNull(lifecycle.beginClose().handle)
    assertNull(lifecycle.current())
  }

  @Test
  fun `closing never restores vacuous success`() {
    val lifecycle = FileSinkLifecycle()
    assertTrue(lifecycle.beginOpen())
    lifecycle.finishOpen(handle())
    lifecycle.beginClose()

    assertFalse(lifecycle.vacuousSuccess)
  }

  @Test
  fun `a closed sink can be opened again`() {
    val lifecycle = FileSinkLifecycle()
    assertTrue(lifecycle.beginOpen())
    lifecycle.finishOpen(handle())
    lifecycle.beginClose()

    assertTrue(lifecycle.beginOpen())
  }

  // MARK: close racing open

  @Test
  fun `a close arriving during acquisition cancels the open`() {
    val lifecycle = FileSinkLifecycle()
    assertTrue(lifecycle.beginOpen())

    assertNull(lifecycle.beginClose().handle)
    assertEquals(FileSinkLifecycle.State.CLOSE_PENDING, lifecycle.currentState)

    assertEquals(FileSinkLifecycle.Installation.ABANDON, lifecycle.finishOpen(handle()))
    assertEquals(FileSinkLifecycle.State.CLOSED, lifecycle.currentState)
    assertNull(lifecycle.current())
  }

  @Test
  fun `a cancelled open does not cancel the one after it`() {
    val lifecycle = FileSinkLifecycle()
    assertTrue(lifecycle.beginOpen())
    lifecycle.beginClose()
    assertEquals(FileSinkLifecycle.Installation.ABANDON, lifecycle.finishOpen(handle()))

    assertTrue(lifecycle.beginOpen())
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
    assertTrue(lifecycle.beginOpen())

    assertNull(lifecycle.beginClose().handle)
    assertNull(lifecycle.beginClose().handle)
    assertEquals(FileSinkLifecycle.State.CLOSE_PENDING, lifecycle.currentState)
    assertFalse(lifecycle.beginOpen())

    // The first acquisition finally lands, and is still discarded.
    val stale = handle()
    assertEquals(FileSinkLifecycle.Installation.ABANDON, lifecycle.finishOpen(stale))
    assertNull(lifecycle.current())

    // Only now is the sink free, and the next open gets its own handle.
    assertTrue(lifecycle.beginOpen())
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
    assertTrue(lifecycle.beginOpen())
    assertNull(lifecycle.beginClose().handle)

    assertNull(lifecycle.beginDispose().handle)
    assertEquals(FileSinkLifecycle.State.DISPOSED, lifecycle.currentState)
    assertEquals(FileSinkLifecycle.Installation.ABANDON, lifecycle.finishOpen(handle()))
    assertFalse(lifecycle.beginOpen())
  }

  @Test
  fun `an open is refused while a cancelled acquisition is still in flight`() {
    val lifecycle = FileSinkLifecycle()
    assertTrue(lifecycle.beginOpen())
    lifecycle.beginClose()

    assertEquals(FileSinkLifecycle.State.CLOSE_PENDING, lifecycle.currentState)
    assertFalse(lifecycle.beginOpen())
  }

  // MARK: dispose

  @Test
  fun `dispose is terminal where close is not`() {
    val lifecycle = FileSinkLifecycle()
    val live = handle()
    assertTrue(lifecycle.beginOpen())
    lifecycle.finishOpen(live)

    assertSame(live, lifecycle.beginDispose().handle)
    assertEquals(FileSinkLifecycle.State.DISPOSED, lifecycle.currentState)
    assertFalse(lifecycle.beginOpen())
  }

  @Test
  fun `disposing during acquisition also discards the handle`() {
    val lifecycle = FileSinkLifecycle()
    assertTrue(lifecycle.beginOpen())

    assertNull(lifecycle.beginDispose().handle)
    assertEquals(FileSinkLifecycle.Installation.ABANDON, lifecycle.finishOpen(handle()))
    assertEquals(FileSinkLifecycle.State.DISPOSED, lifecycle.currentState)
  }

  @Test
  fun `disposing twice is harmless`() {
    val lifecycle = FileSinkLifecycle()
    assertTrue(lifecycle.beginOpen())
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
    assertTrue(lifecycle.beginOpen())
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
    assertTrue(lifecycle.beginOpen())
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

    runConcurrently(64) { if (lifecycle.beginOpen()) winners.incrementAndGet() }

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
    assertTrue(lifecycle.beginOpen())
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
