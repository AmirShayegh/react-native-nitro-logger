package com.margelo.nitro.nitrologger

import java.io.File
import java.util.concurrent.atomic.AtomicLong
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The Kotlin half of the perf harness: allocated bytes per burst, printed.
 *
 * The 0.4.0 audit priced several writer items in allocations rather than
 * time — boxed clock `Long`s (K3), per-entry name strings in the sweep (K2),
 * a `SimpleDateFormat` per rotation (K8) — and a time-only harness would let
 * an allocation regression hide inside timer noise. This one asks the JVM
 * how many bytes each burst allocated and prints the answer; nothing asserts
 * on the number, ever, because the numbers are before/after instruments for
 * one machine and one session, not gates.
 *
 * ## Why `ThreadMXBean` and not `Debug.startAllocCounting`
 *
 * The audit sketched `Debug.startAllocCounting`, which counts on ART — and
 * only on a device, inside the instrumented job, minutes per answer. This
 * suite runs on the JVM in seconds on the machine where the work happens,
 * and a RELATIVE signal (did this commit allocate less than the last one,
 * same host, same VM) is what per-commit before/after needs. ART and HotSpot
 * do not allocate identically; neither harness claims device truth, and the
 * one that runs per-commit is the one that gets consulted. The trade is
 * recorded here so nobody rediscovers it.
 *
 * The counter is summed across ALL live threads, before and after: the
 * writer does its work on its own executor thread, so a caller-thread
 * counter would miss most of what the audit priced. The delta includes any
 * other thread that allocated meanwhile — on this JVM, during these bursts,
 * that contamination is small and CONSTANT between two runs, which is all a
 * relative instrument needs.
 *
 * On a JVM without `com.sun.management` support the tests still run their
 * bursts and still assert delivery — they say so loudly instead of printing
 * numbers. Never a skip: `check-test-reports` counts a skip as a hole, and
 * the delivery assertions hold on every JVM.
 */
class AllocationHarnessTest {
  private lateinit var directory: File
  private lateinit var registry: LogWriterRegistry
  private val handles = mutableListOf<LogFileHandle>()
  private val now = AtomicLong(System.currentTimeMillis())

  @Before
  fun setUp() {
    now.set(System.currentTimeMillis())
    directory = File.createTempFile("nitro-alloc-harness", "").let {
      it.delete()
      File(it.absolutePath + "-dir").apply { mkdirs() }
    }
    registry = LogWriterRegistry.isolated()
  }

  @After
  fun tearDown() {
    handles.forEach { runCatching { it.close(1000.0) } }
    handles.clear()
    directory.deleteRecursively()
  }

  private fun handle(
    policy: LogRotationPolicy = LogRotationPolicy.of()
  ): LogFileHandle = registry.acquire(
    path = File(directory, "app.log").absolutePath,
    policy = policy,
    lineFramed = true,
    platform = PlatformIo.Jvm,
    clock = { now.get() }
  ).also { handles.add(it) }

  private fun line(index: Int) = "%08d ".format(index) + "x".repeat(40) + "\n"

  /**
   * Allocated bytes across every live thread, or null when unsupported.
   *
   * Reflection, because of where this compiles versus where it runs: unit
   * tests compile against `android.jar`, which has no `java.lang.management`
   * at all, while the JVM that actually executes them has both it and the
   * `com.sun.management` extension. Every call funnels through `runCatching`
   * so a JVM without either answers null — reported loudly by `report` —
   * rather than failing a suite whose real assertions are about delivery.
   * Methods are looked up on the PUBLIC types (the two `ThreadMXBean`
   * interfaces), never the implementation class: invoking through an
   * internal class trips Java 9+ module encapsulation.
   */
  private fun allocatedAcrossThreads(): Long? = runCatching {
    val bean = Class.forName("java.lang.management.ManagementFactory")
      .getMethod("getThreadMXBean")
      .invoke(null) ?: return null
    val sunInterface = Class.forName("com.sun.management.ThreadMXBean")
    if (!sunInterface.isInstance(bean)) return null
    if (sunInterface.getMethod("isThreadAllocatedMemorySupported")
        .invoke(bean) != true
    ) return null
    if (sunInterface.getMethod("isThreadAllocatedMemoryEnabled")
        .invoke(bean) != true
    ) {
      sunInterface
        .getMethod("setThreadAllocatedMemoryEnabled", Boolean::class.javaPrimitiveType)
        .invoke(bean, true)
    }
    val ids = Class.forName("java.lang.management.ThreadMXBean")
      .getMethod("getAllThreadIds")
      .invoke(bean) as LongArray
    val allocated = sunInterface
      .getMethod("getThreadAllocatedBytes", LongArray::class.java)
      .invoke(bean, ids) as LongArray
    allocated.filter { it > 0 }.sum()
  }.getOrNull()

  private fun report(name: String, entries: Int, burst: () -> Unit) {
    val before = allocatedAcrossThreads()
    burst()
    val after = allocatedAcrossThreads()
    if (before == null || after == null) {
      println("[alloc-harness] $name: allocation counting unsupported on this JVM; burst ran, no number")
      return
    }
    val delta = after - before
    println("[alloc-harness] $name: $delta bytes / $entries entries = ${delta / entries} B/entry")
  }

  /** `FULL` is backpressure, not failure — flush and come back, as the
   * batcher does. Same shape as `LogBurstTest.push`. */
  private fun push(handle: LogFileHandle, text: String) {
    var result = handle.appendBatch(text, 1L)
    var spins = 0
    while (!result.accepted && result.rejectReason == LogRejectReason.FULL && spins < 1000) {
      handle.flush(1000.0)
      result = handle.appendBatch(text, 1L)
      spins += 1
    }
    assertTrue("record was not accepted", result.accepted)
  }

  @Test
  fun `allocation per plain append burst`() {
    val w = handle(policy = LogRotationPolicy.of(maxFileSizeBytes = 1e9))
    val entries = 2_000
    report("plain-append", entries) {
      for (index in 0 until entries) push(w, line(index))
      assertTrue(w.flush(10_000.0).durable)
    }
    // The delivery assertion is the executes-only contract: the burst really
    // happened, whatever the JVM could say about its allocations.
    assertEquals(0L, w.status().lostEntries)
    // Fifty bytes a record: the 49 visible characters plus the newline.
    assertEquals(entries * 50L, File(directory, "app.log").length())
  }

  @Test
  fun `allocation per rotation-and-sweep burst`() {
    val w = handle(
      policy = LogRotationPolicy.of(maxFileSizeBytes = 4096.0, maxArchivedFilesCount = 10.0)
    )
    val entries = 2_000
    report("rotate-and-sweep", entries) {
      for (index in 0 until entries) push(w, line(index))
      assertTrue(w.flush(10_000.0).durable)
    }
    assertEquals(0L, w.status().lostEntries)
    val archives = (directory.list() ?: emptyArray())
      .filter { LogFileWriter.isArchiveName(it, "app.log") }
    assertTrue("the burst really did rotate, saw ${archives.size}", archives.isNotEmpty())
  }
}
