package com.margelo.nitro.nitrologger

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference

/**
 * One writer per file, and the fencing that depends on it.
 *
 * The registry is the reason two destinations pointed at the same path do not
 * interleave mid-record or archive each other's fresh output, so most of these
 * are about identity: the same file resolved by different names must land on
 * the same writer, and a writer that is still closing must not be raced by a
 * replacement.
 */
class LogWriterRegistryTest {
  private lateinit var directory: File
  private lateinit var registry: LogWriterRegistry
  private val handles = mutableListOf<LogFileHandle>()

  @Before
  fun setUp() {
    directory = File.createTempFile("nitro-registry-test", "").let {
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
    // The epoch is process-wide, and the owner tests below mint tokens in it.
    // A token left live would be a token another test's sweep could find.
    ReactInstanceEpoch.releaseOwner = defaultRelease
    ReactInstanceEpoch.resetForTesting()
  }

  private val defaultRelease = ReactInstanceEpoch.releaseOwner

  private fun acquire(
    path: String,
    policy: LogRotationPolicy = LogRotationPolicy.of(),
    lineFramed: Boolean = true,
    owner: Long? = null,
    rawWrite: LogFileWriter.RawWrite? = null
  ): LogFileHandle = registry.acquire(
    path = path,
    policy = policy,
    lineFramed = lineFramed,
    platform = PlatformIo.Jvm,
    rawWrite = rawWrite,
    clock = { 1_700_000_000_000L },
    owner = owner
  ).also { handles.add(it) }

  // Two streams appending to one file from different threads interleave
  // mid-record. Identity is what makes that impossible.
  @Test
  fun `paths that name the same file share one writer`() {
    val direct = acquire(File(directory, "app.log").absolutePath)
    val roundabout = acquire(File(directory, "sub/../app.log").absolutePath)

    assertEquals(1, registry.liveWriterCountForTesting)
    assertEquals(direct.filePath, roundabout.filePath)
  }

  @Test
  fun `different files get different writers`() {
    acquire(File(directory, "one.log").absolutePath)
    acquire(File(directory, "two.log").absolutePath)
    assertEquals(2, registry.liveWriterCountForTesting)
  }

  // Silently honouring the first caller's policy gives the second a file that
  // behaves nothing like what it asked for.
  @Test
  fun `a second handle with a conflicting policy is refused`() {
    val path = File(directory, "app.log").absolutePath
    acquire(path, policy = LogRotationPolicy.of(maxFileSizeBytes = 1024.0))

    try {
      acquire(path, policy = LogRotationPolicy.of(maxFileSizeBytes = 2048.0))
      fail("expected a config conflict")
    } catch (e: LogWriterException) {
      assertEquals(LogWriterException.Kind.CONFIG_CONFLICT, e.kind)
    }
  }

  @Test
  fun `a second handle with a conflicting framing contract is refused`() {
    val path = File(directory, "app.log").absolutePath
    acquire(path, lineFramed = true)

    try {
      acquire(path, lineFramed = false)
      fail("expected a config conflict")
    } catch (e: LogWriterException) {
      assertEquals(LogWriterException.Kind.CONFIG_CONFLICT, e.kind)
    }
  }

  @Test
  fun `the writer is evicted only when the last handle goes`() {
    val path = File(directory, "app.log").absolutePath
    val first = acquire(path)
    val second = acquire(path)

    first.close(1000.0)
    assertEquals(1, registry.liveWriterCountForTesting)

    second.close(1000.0)
    assertEquals(0, registry.liveWriterCountForTesting)
  }

  // Following a symlink would write the app's log wherever it points — a path
  // the caller never named and the purge would never clean.
  @Test
  fun `a symlinked log file is refused`() {
    val real = File(directory, "elsewhere.log")
    real.writeText("")
    val link = File(directory, "app.log")
    // Assumed, not returned from. A bare `return` reports green for a test that
    // never ran its own invariant; a skip is caught by `check-test-reports.sh`,
    // which counts one as a hole rather than a pass.
    Assume.assumeTrue(
      "this filesystem makes symbolic links",
      runCatching {
        java.nio.file.Files.createSymbolicLink(link.toPath(), real.toPath())
      }.isSuccess
    )

    try {
      acquire(link.absolutePath)
      fail("expected a symlink escape")
    } catch (e: LogWriterException) {
      assertEquals(LogWriterException.Kind.SYMLINK_ESCAPE, e.kind)
    }
  }

  @Test
  fun `an empty path is refused rather than resolved to something`() {
    try {
      acquire("")
      fail("expected an open failure")
    } catch (e: LogWriterException) {
      assertEquals(LogWriterException.Kind.OPEN_FAILED, e.kind)
    }
  }

  @Test
  fun `a path that names a directory rather than a file is refused`() {
    try {
      acquire(directory.absolutePath + "/..")
      fail("expected an open failure")
    } catch (e: LogWriterException) {
      assertEquals(LogWriterException.Kind.OPEN_FAILED, e.kind)
    }
  }

  // MARK: - Handle semantics

  @Test
  fun `a closed handle refuses to append`() {
    val handle = acquire(File(directory, "app.log").absolutePath)
    handle.close(1000.0)

    val result = handle.appendBatch("after\n", 1)
    assertFalse(result.accepted)
    assertEquals(LogRejectReason.CLOSED, result.rejectReason)
  }

  @Test
  fun `a handle rebinds itself across a durable purge`() {
    val handle = acquire(File(directory, "app.log").absolutePath)
    assertTrue(handle.appendBatch("before\n", 1).accepted)
    handle.flush(1000.0)

    val outcome = handle.clearLogs(2000.0)
    assertTrue(outcome.durable)
    assertTrue(outcome.rebound)

    // Same handle, no re-acquire: rebinding is its job, not the caller's.
    assertTrue(handle.appendBatch("after\n", 1).accepted)
    handle.flush(1000.0)
    assertEquals("after\n", File(directory, "app.log").readText())
  }

  // A second handle on the same writer did not ask for the purge and has not
  // rebound, so it must be fenced until it notices.
  @Test
  fun `a sibling handle is fenced by another handle's purge`() {
    val path = File(directory, "app.log").absolutePath
    val purger = acquire(path)
    val sibling = acquire(path)

    assertTrue(sibling.appendBatch("before\n", 1).accepted)
    purger.clearLogs(2000.0)

    val result = sibling.appendBatch("after\n", 1)
    assertFalse(result.accepted)
    assertEquals(LogRejectReason.STALE_GENERATION, result.rejectReason)
  }

  @Test
  fun `a purge on a closed handle is refused rather than performed`() {
    val handle = acquire(File(directory, "app.log").absolutePath)
    handle.close(1000.0)

    val outcome = handle.clearLogs(1000.0)
    assertFalse(outcome.durable)
    assertFalse(outcome.rebound)
  }

  // The close budget is one budget, not one per wait.
  @Test
  fun `close spends a single budget across every wait it does`() {
    val handle = acquire(File(directory, "app.log").absolutePath)
    handle.appendBatch("x\n", 1)

    val started = System.currentTimeMillis()
    handle.close(300.0)
    val elapsed = System.currentTimeMillis() - started
    assertTrue("close took $elapsed ms for a 300 ms budget", elapsed < 1_500)
  }

  @Test
  fun `closing twice is not an error`() {
    val handle = acquire(File(directory, "app.log").absolutePath)
    handle.close(500.0)
    handle.close(500.0)
    assertEquals(0, registry.liveWriterCountForTesting)
  }

  // A writer built after the previous one was fully released is a new one, and
  // the path must be free by then.
  @Test
  fun `a path can be reacquired after its writer has closed`() {
    val path = File(directory, "app.log").absolutePath
    val first = acquire(path)
    first.close(1000.0)
    assertEquals(0, registry.closingCountForTesting)

    val second = acquire(path)
    assertNotSame(first, second)
    assertTrue(second.appendBatch("fresh\n", 1).accepted)
  }

  @Test
  fun `handles on the same path report the same file`() {
    val path = File(directory, "app.log").absolutePath
    val a = acquire(path)
    val b = acquire(path)
    assertSame(a.filePath, a.filePath)
    assertEquals(a.filePath, b.filePath)
  }

  // MARK: - Handle lifecycle

  /**
   * Every entry point is gated on the handle still being live, not just on it
   * not being closed yet.
   *
   * A released handle that still answers `status()` lets a disposed destination
   * report queue depth and loss for a writer another handle now owns; one that
   * still answers `logFilePaths()` hands out paths it has no claim to; and one
   * that still flushes submits work behind a barrier that already returned. The
   * iOS handle has gated all three from the start — this is the parity the port
   * dropped.
   */
  @Test
  fun `a closed handle observes nothing and flushes nothing`() {
    val path = File(directory, "app.log").absolutePath
    val handle = acquire(path)
    assertTrue(handle.appendBatch("hello\n", 1).accepted)
    assertTrue(handle.logFilePaths().isNotEmpty())

    handle.close(1000.0)

    val status = handle.status()
    assertEquals(0L, status.queuedBytes)
    assertEquals(0L, status.lostBytes)
    assertEquals(0L, status.lostEntries)
    assertEquals(0, status.degraded)

    assertTrue("a released handle has no claim on these paths", handle.logFilePaths().isEmpty())

    val outcome = handle.flush(500.0)
    assertFalse("a released handle flushed nothing, so it is not durable", outcome.durable)
    assertEquals(0L, outcome.pendingBytes)

    val rejected = handle.appendBatch("late\n", 1)
    assertFalse(rejected.accepted)
    assertEquals(LogRejectReason.CLOSED, rejected.rejectReason)
  }

  /**
   * A second handle on the same file is unaffected by the first one closing.
   *
   * The guard above is per handle, not per writer: closing one destination must
   * not silence another that still holds the same file.
   */
  @Test
  fun `closing one handle leaves a sibling fully live`() {
    val path = File(directory, "app.log").absolutePath
    val first = acquire(path)
    val second = acquire(path)

    first.close(1000.0)

    assertTrue(second.appendBatch("still here\n", 1).accepted)
    assertTrue(second.logFilePaths().isNotEmpty())
    assertTrue(second.flush(1000.0).durable)
  }

  /* ----- Owner claims: what a destroyed React instance leaves behind ----- */

  /**
   * The sweep closes what that instance opened.
   *
   * This is C13 in one test. A React instance is destroyed and its JavaScript
   * dies without closing anything; on Android nothing else can, because
   * `finalize()` never runs. Before this, the writer stayed live forever and the
   * *next* instance could not open its own log file — the file was still held,
   * with the old instance's rotation configuration.
   */
  @Test
  fun `releasing an owner closes the handles it acquired`() {
    val owner = ReactInstanceEpoch.begin()
    val path = File(directory, "app.log").absolutePath
    acquire(path, owner = owner)

    assertEquals(1, registry.claimCountForOwnerForTesting(owner))
    assertEquals(1, registry.liveWriterCountForTesting)

    registry.releaseOwner(owner, 1000.0)

    assertEquals(0, registry.claimCountForOwnerForTesting(owner))
    assertEquals("the writer goes with the runtime that opened it", 0, registry.liveWriterCountForTesting)
  }

  /**
   * And the path is free afterwards — which is the thing the app actually
   * needed. A registry that dropped its bookkeeping but left the file claimed
   * would satisfy the counts above and still fail the reload.
   */
  @Test
  fun `the path a swept owner held can be opened with a new configuration`() {
    val owner = ReactInstanceEpoch.begin()
    val path = File(directory, "app.log").absolutePath
    acquire(path, policy = LogRotationPolicy.of(maxFileSizeBytes = 4096.0), owner = owner)

    registry.releaseOwner(owner, 1000.0)

    // A *different* configuration, because the same one would be handed the
    // existing writer whether or not the sweep did anything.
    val replacement = acquire(path, policy = LogRotationPolicy.of(maxFileSizeBytes = 8192.0))
    assertTrue(replacement.appendBatch("after the reload\n", 1).accepted)
  }

  /**
   * **The unit of release is the claim, not the writer.**
   *
   * Two destinations can share one writer and belong to different instances.
   * Closing the writer when one of them dies would take the log file out from
   * under the survivor — a live handle whose every append is refused.
   */
  @Test
  fun `a writer shared with a live owner survives the sweep`() {
    val dying = ReactInstanceEpoch.begin()
    val path = File(directory, "app.log").absolutePath
    acquire(path, owner = dying)
    val survivor = acquire(path)

    registry.releaseOwner(dying, 1000.0)

    assertEquals(1, registry.liveWriterCountForTesting)
    assertTrue("the surviving destination still owns the file", survivor.appendBatch("mine\n", 1).accepted)
  }

  /**
   * An acquisition for an instance that is already gone is refused rather than
   * granted a writer nobody will ever close. See `ReactInstanceEpoch.end`: the
   * token is dead before the sweep runs, so this is the branch a racing open
   * takes.
   */
  @Test
  fun `acquiring for a destroyed owner is refused`() {
    val owner = ReactInstanceEpoch.begin()
    ReactInstanceEpoch.releaseOwner = { }
    ReactInstanceEpoch.end(owner)

    try {
      acquire(File(directory, "app.log").absolutePath, owner = owner)
      fail("expected the acquisition to be refused")
    } catch (expected: LogWriterException) {
      assertEquals(LogWriterException.Kind.OPEN_FAILED, expected.kind)
    }
    assertEquals("nothing was built for it", 0, registry.liveWriterCountForTesting)
  }

  /**
   * A JavaScript-side close takes the claim with it, so the later sweep has
   * nothing of its own to close.
   */
  @Test
  fun `closing a handle drops its claim`() {
    val owner = ReactInstanceEpoch.begin()
    val handle = acquire(File(directory, "app.log").absolutePath, owner = owner)

    handle.close(1000.0)

    assertEquals(0, registry.claimCountForOwnerForTesting(owner))
  }

  /**
   * The refusal has to survive the wait, and the wait is where it is hardest.
   *
   * An acquisition that finds the path `closing` sleeps on [pathFreed] — and
   * that **releases the registry lock**. Its owner can die and be swept while it
   * is in there, and the sweep finds nothing to take, because this claim is not
   * registered yet. A single liveness check before the wait would let it wake up
   * and register a handle against a runtime that no longer exists and that
   * nothing will ever sweep again: C13 through a smaller gap.
   */
  @Test
  fun `an owned acquisition asleep on a closing path is refused when its owner dies`() {
    val path = File(directory, "app.log").absolutePath
    val stalled = CountDownLatch(1)
    try {
      // A writer whose executor is wedged mid-write. `close` enqueues its
      // termination barrier behind that wedge, so the barrier — and with it the
      // `closing` claim on the path — outlives the close call.
      val first = acquire(path, rawWrite = stallingWrite(stalled))
      first.appendBatch("wedged\n", 1)
      first.close(50.0)
      assertEquals("the close must still be holding the path", 1, registry.closingCountForTesting)

      val owner = ReactInstanceEpoch.begin()
      ReactInstanceEpoch.releaseOwner = { registry.releaseOwner(it, 0.0) }
      val verdict = AtomicReference<Any?>()
      val waiter = acquiringThread(path, LogRotationPolicy.of(), owner, verdict)

      waiter.start()
      awaitThreadState(waiter, Thread.State.TIMED_WAITING, "the acquisition to reach the wait", verdict)

      // Destroyed while it sleeps. The sweep has nothing to close: this claim
      // does not exist yet, which is exactly what makes the recheck necessary.
      ReactInstanceEpoch.end(owner)
      stalled.countDown()
      waiter.join(10_000)

      val refusal = verdict.get()
      if (refusal is LogFileHandle) {
        refusal.close(500.0)
        fail("the acquisition was granted a writer for a runtime that no longer exists")
      }
      assertTrue("expected a refusal, got $refusal", refusal is LogWriterException)
      assertEquals(LogWriterException.Kind.OPEN_FAILED, (refusal as LogWriterException).kind)
      assertEquals("nothing may be claimed for a dead owner", 0, registry.claimCountForOwnerForTesting(owner))
      assertEquals("and nothing may be built for one", 0, registry.liveWriterCountForTesting)
    } finally {
      stalled.countDown()
    }
  }

  /**
   * The middle of a sweep is not a state anyone else can see.
   *
   * Ownership removal and eviction happen together, under the registry lock. Do
   * them apart — drop the claims, unlock, then close — and there is a window in
   * which the writer is still installed and still retained, so the replacement
   * runtime's `open` finds a live writer carrying the *dead* runtime's rotation
   * configuration and is refused `CONFIG_CONFLICT`. That is the reload failure
   * this whole file exists to fix, arriving one layer down.
   *
   * The rival is released into exactly that window and must not get a verdict
   * out of it: blocked on the lock during, waiting on the path after, and open
   * once the writer has finished draining.
   */
  @Test
  fun `a replacement configuration cannot see the middle of a sweep`() {
    val path = File(directory, "app.log").absolutePath
    val stalled = CountDownLatch(1)
    try {
      val owner = ReactInstanceEpoch.begin()
      val handle = acquire(
        path,
        policy = LogRotationPolicy.of(maxFileSizeBytes = 4096.0),
        owner = owner,
        rawWrite = stallingWrite(stalled)
      )
      handle.appendBatch("wedged\n", 1)

      // A configuration the dying runtime is not holding, so a `CONFIG_CONFLICT`
      // here can only mean the rival saw the old writer.
      val verdict = AtomicReference<Any?>()
      val rival = acquiringThread(path, LogRotationPolicy.of(maxFileSizeBytes = 8192.0), null, verdict)

      registry.duringOwnerReleaseForTesting = {
        rival.start()
        // WAITING, not BLOCKED: the registry's lock is a `ReentrantLock`, and
        // AQS parks rather than contending on a monitor. BLOCKED is what a
        // `synchronized` block would give.
        awaitThreadState(rival, Thread.State.WAITING, "the rival to reach the registry lock", verdict)
        assertNull("the rival got a verdict out of the middle of the sweep: ${verdict.get()}", verdict.get())
      }
      registry.releaseOwner(owner, 50.0)
      registry.duringOwnerReleaseForTesting = null

      // Bookkeeping is done, but the writer is still draining behind the wedge,
      // so the rival is now waiting out the path rather than being refused.
      awaitThreadState(rival, Thread.State.TIMED_WAITING, "the rival to wait out the close", verdict)
      stalled.countDown()
      rival.join(10_000)

      val opened = verdict.get()
      if (opened is LogWriterException) {
        fail("the replacement was refused ${opened.kind}: ${opened.message}")
      }
      assertTrue("the replacement never opened: $opened", opened is LogFileHandle)
      val replacement = opened as LogFileHandle
      handles.add(replacement)
      assertTrue("and it owns the file", replacement.appendBatch("after the reload\n", 1).accepted)
    } finally {
      registry.duringOwnerReleaseForTesting = null
      stalled.countDown()
    }
  }

  /**
   * One budget for the sweep, not one per phase.
   *
   * `releaseOwner` waits twice — the flush in `finishOwnerRelease`, then the
   * executor drain in `writer.close` — and a caller asking for 300 ms must not
   * be made to wait 600. This is the teardown path, where the runtime that would
   * have cared about durability is already gone and something is waiting on the
   * main thread for it to be over.
   *
   * Read rather than timed: with the executor wedged the flush is guaranteed to
   * spend the whole budget, so the number handed to the drain is exactly zero,
   * and asserting that says nothing about how loaded the machine is. Timing the
   * call would have made a stalled CI worker look like the bug.
   */
  @Test
  fun `a sweep spends a single budget across every wait it does`() {
    val path = File(directory, "app.log").absolutePath
    val stalled = CountDownLatch(1)
    try {
      val owner = ReactInstanceEpoch.begin()
      // Wedged for the whole test, so the flush runs out rather than finishing
      // early and leaving a budget that proves nothing either way.
      acquire(path, owner = owner, rawWrite = stallingWrite(stalled)).appendBatch("wedged\n", 1)

      val drains = mutableListOf<Double>()
      registry.ownerDrainBudgetForTesting = { drains.add(it) }
      registry.releaseOwner(owner, 300.0)

      assertEquals("one writer, so one drain", 1, drains.size)
      assertEquals("the flush spent the budget; the drain gets what is left", 0.0, drains[0], 0.0)
    } finally {
      registry.ownerDrainBudgetForTesting = null
      stalled.countDown()
    }
  }

  /** A write that parks the writer's executor until [gate] opens. */
  private fun stallingWrite(gate: CountDownLatch) = LogFileWriter.RawWrite { stream, data, offset, length ->
    gate.await()
    stream.write(data, offset, length)
    length
  }

  /**
   * An acquisition on its own thread, reporting whatever it got — handle or
   * exception — into [verdict].
   */
  private fun acquiringThread(
    path: String,
    policy: LogRotationPolicy,
    owner: Long?,
    verdict: AtomicReference<Any?>
  ) = Thread({
    try {
      verdict.set(
        registry.acquire(
          path = path,
          policy = policy,
          lineFramed = true,
          platform = PlatformIo.Jvm,
          clock = { 1_700_000_000_000L },
          owner = owner
        )
      )
    } catch (t: Throwable) {
      verdict.set(t)
    }
  }, "registry-rival")

  /**
   * Waits for [thread] to reach [wanted], or for it to answer early.
   *
   * An early answer is not a timeout — it is the failure these two tests are
   * looking for — so it ends the wait and is left for the assertions.
   */
  private fun awaitThreadState(
    thread: Thread,
    wanted: Thread.State,
    what: String,
    verdict: AtomicReference<Any?>
  ) {
    val deadline = System.nanoTime() + 10_000L * 1_000_000L
    while (System.nanoTime() < deadline) {
      if (thread.state == wanted || verdict.get() != null) return
      Thread.sleep(5)
    }
    fail("timed out waiting for $what; it is ${thread.state}")
  }

  /**
   * Nobody claiming means nothing changes. Every JVM test above this section,
   * and every host that does not install `NitroLoggerLifecycle`, acquires with a
   * null owner — and a sweep must not be able to reach those.
   */
  @Test
  fun `handles with no owner are untouched by a sweep`() {
    val owner = ReactInstanceEpoch.begin()
    val unowned = acquire(File(directory, "app.log").absolutePath)

    registry.releaseOwner(owner, 1000.0)

    assertEquals(1, registry.liveWriterCountForTesting)
    assertTrue(unowned.appendBatch("still here\n", 1).accepted)
  }
}
