package com.margelo.nitro.nitrologger

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * The Android half of the shared no-handle table.
 *
 * The table lives in `spec/file-sink-lifecycle.rows.json` and is read by three
 * suites: this one, `__tests__/fileSinkLifecycleRows.test.ts`, and
 * `FileSinkLifecycleRowsTests.swift`. Its header explains why the answers live
 * in one file rather than in three hand-written suites that drifted apart on
 * four rows without anyone noticing.
 *
 * ## What this does NOT prove
 *
 * That `HybridFileSink` answers this way. That file extends a nitrogen-generated
 * base and cannot be constructed off a device, so nothing here executes a line
 * of it. [answer] below derives each answer from [FileSinkLifecycle] the way the
 * adapter does — deliberately through the same `snapshot()` / `artifactSource()`
 * calls, so a change to the lifecycle's verdict breaks this suite — but the
 * marshalling in between is out of reach until the `FileSinkAnswers` extraction
 * lands. At that point [answer] delegates instead of deriving, and these same
 * rows start pinning the adapter.
 */
class FileSinkLifecycleRowsTest {
  private lateinit var directory: File
  private lateinit var registry: LogWriterRegistry
  private val handles = mutableListOf<LogFileHandle>()

  @Before
  fun setUp() {
    directory = File.createTempFile("nitro-lifecycle-rows", "").let {
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

  // MARK: loading

  private data class Row(val op: String, val why: String, val answers: Map<String, Map<String, String>>)

  private data class Table(val modes: List<String>, val rows: List<Row>)

  private fun loadTable(): Table {
    // A JVM unit test's working directory is whatever the Gradle worker chose
    // and is not the repository, so `android/build.gradle` hands the root in.
    // A missing property is a failure rather than a default, because every
    // default here is a path that resolves to nothing and skips the suite.
    val root = System.getProperty("nitroLogger.repoRoot")
      ?: throw AssertionError(
        "nitroLogger.repoRoot is unset — see testOptions.unitTests in android/build.gradle"
      )
    val file = File(root, "spec/file-sink-lifecycle.rows.json")
    assertTrue("no table at ${file.absolutePath}", file.isFile)

    val json = JsonParser.parseString(file.readText()).asJsonObject
    val modes = json.getAsJsonArray("modes").map { it.asString }
    val rows = json.getAsJsonArray("rows").map { element ->
      val entry = element.asJsonObject
      val op = entry.get("op").asString
      Row(
        op = op,
        why = entry.get("why").asString,
        answers = modes.associateWith { mode ->
          val answer = entry.get(mode) as? JsonObject
            ?: throw AssertionError("row `$op` has no answer for mode `$mode`")
          answer.entrySet().associate { (key, value) -> key to value.asString }
        }
      )
    }
    return Table(modes, rows)
  }

  // MARK: the two modes

  /** A sink that was never opened: no handle, and nothing can exist yet. */
  private fun neverOpened(): FileSinkLifecycle = FileSinkLifecycle()

  /**
   * A sink that opened, wrote, and closed: no handle, and files may exist.
   *
   * The file is left on disk on purpose. `getLogFilePaths` enumerates the
   * directory rather than remembering a list, so a mode that deleted its file
   * would answer `pathCount: 0` and agree with the never-opened row for a
   * reason the table does not describe.
   */
  private fun openedThenClosed(): FileSinkLifecycle {
    val lifecycle = FileSinkLifecycle()
    assertEquals(FileSinkLifecycle.Claim.GRANTED, lifecycle.beginOpen())
    val live = handle()
    assertEquals(FileSinkLifecycle.Installation.INSTALLED, lifecycle.finishOpen(live))
    live.appendBatch("{\"m\":1}\n", 1L)
    lifecycle.beginClose().handle?.close(1000.0)
    assertNull("the mode is defined by having no handle", lifecycle.current())
    return lifecycle
  }

  private fun lifecycleFor(mode: String): FileSinkLifecycle = when (mode) {
    "neverOpened" -> neverOpened()
    "openedThenClosed" -> openedThenClosed()
    // Never a skip. A mode this target cannot build is a mode this target does
    // not test, and a green suite would report the opposite.
    else -> throw AssertionError("no builder for mode `$mode`")
  }

  // MARK: the dispatcher

  private val dispatchedOps = listOf(
    "appendBatch", "getStatus", "maintain", "collectLogs", "flush",
    "close", "clearLogs", "deleteSupportBundle", "getLogFilePaths"
  )

  /**
   * Each branch is the body `HybridFileSink` runs when its handle is null,
   * reading the same lifecycle calls in the same order.
   *
   * Returns null for an op this target does not implement, which the caller
   * turns into a failure.
   */
  private fun answer(op: String, lifecycle: FileSinkLifecycle): Map<String, String>? = when (op) {
    "appendBatch" -> {
      if (lifecycle.current() != null) null
      else mapOf(
        "accepted" to "false", "rejectReason" to "closed", "queuedBytes" to "0",
        "lostBytes" to "0", "lostEntries" to "0", "degraded" to "0"
      )
    }

    "getStatus", "maintain" -> {
      if (lifecycle.current() != null) null
      else mapOf(
        "queuedBytes" to "0", "lostBytes" to "0", "lostEntries" to "0", "degraded" to "0"
      )
    }

    "collectLogs" -> {
      if (lifecycle.current() != null) null
      else mapOf(
        "path" to "", "byteCount" to "0", "sourceFileCount" to "0",
        "complete" to "true", "truncated" to "false"
      )
    }

    "flush" -> {
      val snapshot = lifecycle.snapshot()
      if (snapshot.handle != null) null
      else noHandleFlush(snapshot.durableWithoutHandle)
    }

    "close" -> {
      val first = lifecycle.beginClose()
      if (first.handle != null) {
        null
      } else {
        val second = lifecycle.beginClose()
        assertEquals(
          "closing twice must answer what the first close answered",
          first.durableWithoutHandle, second.durableWithoutHandle
        )
        noHandleFlush(second.durableWithoutHandle)
      }
    }

    "clearLogs" -> {
      val snapshot = lifecycle.snapshot()
      if (snapshot.handle != null) null
      else mapOf(
        "deletedCount" to "0", "failedPathCount" to "0",
        "durable" to snapshot.durableWithoutHandle.toString(), "rebound" to "false"
      )
    }

    // `snapshot()`, not `artifactSource()`. A sink that opened and closed knows
    // where its bundle would be but cannot confirm it is gone, and `true` there
    // deletes the caller's obligation to retry. This is the one row that was
    // wrong in shipped code, and it was found by review rather than by a test
    // because no test could reach the file.
    "deleteSupportBundle" -> {
      val snapshot = lifecycle.snapshot()
      if (snapshot.handle != null) null
      else mapOf("deleted" to snapshot.durableWithoutHandle.toString())
    }

    "getLogFilePaths" -> {
      val source = lifecycle.artifactSource()
      when {
        source.handle != null -> null
        source.path == null -> mapOf("pathCount" to "0")
        else -> mapOf(
          "pathCount" to LogFileWriter.artifactPaths(File(source.path!!)).size.toString()
        )
      }
    }

    else -> null
  }

  private fun noHandleFlush(durable: Boolean): Map<String, String> = mapOf(
    "durable" to durable.toString(), "timedOut" to "false", "pendingBytes" to "0",
    "queuedBytes" to "0", "lostBytes" to "0", "lostEntries" to "0", "degraded" to "0"
  )

  // MARK: guards
  //
  // A shared table is only shared if every consumer is forced to keep up with
  // it. Each guard turns a way of quietly falling behind into a failure: a row
  // nobody dispatches, an op the table does not carry, a table that shrank.
  // Without them a new row would pass here by being ignored, and "add a row and
  // watch three suites go red" would describe something that does not happen.

  /**
   * Pinned, not derived. `rows.size >= rows.size` is the shape of gate this
   * repository has already shipped twice by accident.
   */
  private val pinnedRowFloor = 9
  private val pinnedModes = listOf("neverOpened", "openedThenClosed")

  @Test
  fun `the table still has every row this floor was pinned against`() {
    assertTrue(loadTable().rows.size >= pinnedRowFloor)
  }

  @Test
  fun `the table declares exactly the modes this target can build`() {
    assertEquals(pinnedModes, loadTable().modes)
  }

  @Test
  fun `every row names an op this target dispatches`() {
    val unknown = loadTable().rows.map { it.op }.filterNot { it in dispatchedOps }
    assertEquals("unimplemented rows are a failure, never a skip", emptyList<String>(), unknown)
  }

  @Test
  fun `every op this target dispatches has a row`() {
    val covered = loadTable().rows.map { it.op }.toSet()
    assertEquals(
      "an op answered here but absent from the table is answered by nobody else",
      emptyList<String>(), dispatchedOps.filterNot { it in covered }
    )
  }

  @Test
  fun `no op is listed twice`() {
    // Without this the headline claim — add a row, watch three suites go red —
    // has a hole in it: a tenth row duplicating an existing op and its answers
    // dispatches the same code a second time and passes everywhere. The row
    // count would even rise, satisfying every floor.
    val ops = loadTable().rows.map { it.op }
    assertEquals("a duplicated op tests nothing twice", ops.toSet().size, ops.size)
  }

  @Test
  fun `every row explains itself`() {
    // Not decoration. `complete: true` over an empty collect and
    // `durable: true` over a sink that never opened both read as bugs until you
    // know why.
    loadTable().rows.forEach {
      assertTrue("row `${it.op}` does not say why", it.why.length > 40)
    }
  }

  // MARK: the rows

  @Test
  fun `every row answers as the table says`() {
    val table = loadTable()
    var checked = 0

    for (mode in table.modes) {
      for (row in table.rows) {
        val expected = row.answers[mode]
        if (expected == null) {
          fail("row `${row.op}` has no answer for `$mode`")
          continue
        }
        val actual = answer(row.op, lifecycleFor(mode))
        if (actual == null) {
          fail("no dispatcher for `${row.op}`, or it found a live handle in `$mode`")
          continue
        }

        // Field-for-field in both directions, between the TABLE and the
        // DISPATCHER: a field the table names that [answer] does not produce
        // fails, and so does the reverse. It is deliberately not a claim about
        // SinkStatus or FlushOutcome growing a field — those types are not
        // reachable from this target at all, which is the whole reason this
        // file exists. The Jest half pins their key sets.
        assertEquals("`${row.op}` in mode `$mode`: ${row.why}", expected, actual)
        checked++
      }
    }

    // The loop above is only worth its assertions if it ran. A table that
    // parsed to zero rows, or a mode list that came back empty, would otherwise
    // report a pass having compared nothing.
    assertEquals(
      "every row must be checked in every mode",
      table.modes.size * table.rows.size, checked
    )
    assertTrue(checked >= pinnedModes.size * pinnedRowFloor)
  }
}
