package com.margelo.nitro.nitrologger

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File

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
  }

  private fun acquire(
    path: String,
    policy: LogRotationPolicy = LogRotationPolicy.of(),
    lineFramed: Boolean = true
  ): LogFileHandle = registry.acquire(
    path = path,
    policy = policy,
    lineFramed = lineFramed,
    platform = PlatformIo.Jvm,
    clock = { 1_700_000_000_000L }
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
    try {
      java.nio.file.Files.createSymbolicLink(link.toPath(), real.toPath())
    } catch (_: Exception) {
      return // the filesystem will not make one; nothing to assert
    }

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
}
