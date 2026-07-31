package com.margelo.nitro.nitrologger

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.After
import org.junit.Assert.assertEquals
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
 * Every answer below is produced by calling [FileSinkAnswers], which is the
 * object `HybridFileSink` delegates to for all nine of these ops.
 *
 * ## What this does NOT prove
 *
 * That the `Wire*`-to-nitrogen copy in `HybridFileSink` is faithful. That class
 * extends a nitrogen-generated base and still cannot be constructed off a
 * device. What it now contains is a field-for-field copy and nothing else —
 * `adapterThinness.test.js` pins that with a line ceiling and a ban on
 * `lifecycle.` calls — and the copy itself is covered end to end only by the
 * min-rn smoke jobs. A real reduction of the gap, not its elimination.
 */
class FileSinkLifecycleRowsTest {
  private lateinit var directory: File
  private lateinit var registry: LogWriterRegistry

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
    directory.deleteRecursively()
  }

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
  private fun neverOpened(): FileSinkAnswers =
    FileSinkAnswers(registry = registry, platform = PlatformIo.Jvm, owner = null)

  /**
   * A sink that opened, wrote, and closed: no handle, and files may exist.
   *
   * The file is left on disk on purpose. `getLogFilePaths` enumerates the
   * directory rather than remembering a list, so a mode that deleted its file
   * would answer `pathCount: 0` and agree with the never-opened row for a
   * reason the table does not describe.
   */
  private fun openedThenClosed(): FileSinkAnswers {
    val answers = neverOpened()
    answers.open(File(directory, "app.log").absolutePath, LogRotationPolicy.of(), true)
    answers.appendBatch("{\"m\":1}\n", 1.0)
    assertTrue(answers.close(1000.0).durable)
    return answers
  }

  private fun sinkFor(mode: String): FileSinkAnswers = when (mode) {
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
   * Calls [FileSinkAnswers] and renders the answer's fields to strings.
   *
   * It does not decide anything: every value below comes back from the object
   * under test. Returns null for an op this target does not implement, which
   * the caller turns into a failure.
   */
  private fun answer(op: String, answers: FileSinkAnswers): Map<String, String>? = when (op) {
    "appendBatch" -> {
      val r = answers.appendBatch("{\"m\":2}\n", 1.0)
      mapOf(
        "accepted" to r.accepted.toString(),
        // The wire spelling, not a default: an implementation that refused
        // without saying why would be reporting something the table does not
        // describe.
        "rejectReason" to (r.rejectReason?.wire ?: "<absent>"),
        "queuedBytes" to number(r.queuedBytes),
        "lostBytes" to number(r.lostBytes),
        "lostEntries" to number(r.lostEntries),
        "degraded" to number(r.degraded)
      )
    }

    "getStatus" -> status(answers.getStatus())

    "maintain" -> status(answers.maintain(1000.0))

    "collectLogs" -> {
      val o = answers.collectLogs(1000.0, 1_000_000.0)
      mapOf(
        "path" to o.path,
        "byteCount" to number(o.byteCount),
        "sourceFileCount" to number(o.sourceFileCount),
        "complete" to o.complete.toString(),
        "truncated" to o.truncated.toString()
      )
    }

    "flush" -> flush(answers.flush(1000.0))

    "close" -> {
      val first = answers.close(1000.0)
      val second = answers.close(1000.0)
      // Idempotence is a relation between two calls, so it cannot be a row.
      // The table pins what the answer *is*; this pins that asking twice does
      // not change it.
      assertEquals("closing twice must answer what the first close answered", first, second)
      flush(second)
    }

    "clearLogs" -> {
      val o = answers.clearLogs(1000.0)
      mapOf(
        "deletedCount" to number(o.deletedCount),
        "failedPathCount" to o.failedPaths.size.toString(),
        "durable" to o.durable.toString(),
        "rebound" to o.rebound.toString()
      )
    }

    "deleteSupportBundle" -> mapOf("deleted" to answers.deleteSupportBundle(1000.0).toString())

    "getLogFilePaths" -> mapOf("pathCount" to answers.getLogFilePaths().size.toString())

    else -> null
  }

  /**
   * `Double` renders as `0.0`, and the table says `0`. Integral values only,
   * which every field here is — a fractional byte count would fail loudly
   * rather than being rounded into agreement.
   */
  private fun number(value: Double): String =
    if (value == Math.rint(value) && !value.isInfinite()) value.toLong().toString()
    else value.toString()

  private fun status(s: WireSinkStatus): Map<String, String> = mapOf(
    "queuedBytes" to number(s.queuedBytes), "lostBytes" to number(s.lostBytes),
    "lostEntries" to number(s.lostEntries), "degraded" to number(s.degraded)
  )

  private fun flush(o: WireFlushOutcome): Map<String, String> = mapOf(
    "durable" to o.durable.toString(), "timedOut" to o.timedOut.toString(),
    "pendingBytes" to number(o.pendingBytes), "queuedBytes" to number(o.queuedBytes),
    "lostBytes" to number(o.lostBytes), "lostEntries" to number(o.lostEntries),
    "degraded" to number(o.degraded)
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
        val actual = answer(row.op, sinkFor(mode))
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
