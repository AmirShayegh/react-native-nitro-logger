package com.margelo.nitro.nitrologger

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The logcat twin of `NativeConsoleWriterTests.swift`, test for test where the
 * platforms agree.
 *
 * The chunk size differs — logcat stores about 4 KB per entry against the
 * unified log's 1 KB — but every behaviour around that limit is meant to be
 * identical, and these are what say so.
 */
class NativeConsoleWriterTest {

  private fun utf8(text: String) = text.toByteArray(Charsets.UTF_8).size

  /** Records what would have reached logcat. */
  private class Recorder {
    val entries = mutableListOf<Triple<Int, String, String>>()
    val emit: (Int, String, String) -> Unit = { p, t, m -> entries.add(Triple(p, t, m)) }
  }

  // MARK: - Level mapping

  /**
   * Priorities are the ones logcat filters on, so a wrong map means a warning
   * nobody sees. Codes are `LEVEL_ORDER` in TypeScript.
   */
  @Test
  fun `the level map matches the shared level order`() {
    assertEquals(android.util.Log.VERBOSE, NativeConsoleWriter.priorityOf(0.0))
    assertEquals(android.util.Log.DEBUG, NativeConsoleWriter.priorityOf(1.0))
    assertEquals(android.util.Log.INFO, NativeConsoleWriter.priorityOf(2.0))
    assertEquals(android.util.Log.WARN, NativeConsoleWriter.priorityOf(3.0))
    assertEquals(android.util.Log.ERROR, NativeConsoleWriter.priorityOf(4.0))
    assertEquals(android.util.Log.ASSERT, NativeConsoleWriter.priorityOf(5.0))
  }

  /**
   * `toInt()` does not report a bad level, it saturates — `NaN` becomes 0,
   * which is `VERBOSE`, the priority most likely to be filtered out entirely.
   * A corrupt level must not be able to hide a line.
   */
  @Test
  fun `a value that cannot be an int is not silently demoted`() {
    for (code in listOf(Double.NaN, 1e30, -1e30, Double.POSITIVE_INFINITY,
                        Double.NEGATIVE_INFINITY)) {
      assertNotEquals("$code must not map to VERBOSE",
                      android.util.Log.VERBOSE, NativeConsoleWriter.priorityOf(code))
      assertEquals("$code carries no severity worth trusting",
                   android.util.Log.INFO, NativeConsoleWriter.priorityOf(code))
    }
  }

  /** Shown, not escalated: an unknown code is not evidence of a crisis. */
  @Test
  fun `an unrecognised code is visible but not alarming`() {
    assertEquals(android.util.Log.INFO, NativeConsoleWriter.priorityOf(99.0))
    assertEquals(android.util.Log.INFO, NativeConsoleWriter.priorityOf(-1.0))
  }

  /**
   * A near-integer code is a level that survived a float round trip, not a
   * corrupt one, and iOS reads it the same way. Mirrors
   * `testFractionalCodesRoundToTheNearestLevel`.
   */
  @Test
  fun `fractional codes round to the nearest level`() {
    assertEquals(android.util.Log.ERROR, NativeConsoleWriter.priorityOf(3.6))
    assertEquals(android.util.Log.WARN, NativeConsoleWriter.priorityOf(3.4))
  }

  /**
   * Ties round away from zero, because that is what Swift's `.rounded()` does
   * and a level map may not disagree across platforms.
   *
   * `Math.round` would answer differently on every negative tie here — it is
   * half-*up*, so it maps -0.5 to VERBOSE where iOS maps it to nothing in
   * range and falls back to INFO.
   */
  @Test
  fun `ties round away from zero, matching iOS`() {
    assertEquals(android.util.Log.DEBUG, NativeConsoleWriter.priorityOf(0.5))
    assertEquals(android.util.Log.WARN, NativeConsoleWriter.priorityOf(2.5))
    assertEquals(android.util.Log.ASSERT, NativeConsoleWriter.priorityOf(4.5))

    // Away from zero puts these below 0, so they are out of range entirely.
    assertEquals(android.util.Log.INFO, NativeConsoleWriter.priorityOf(-0.5))
    assertEquals(android.util.Log.INFO, NativeConsoleWriter.priorityOf(-1.5))
  }

  /** Just inside zero still rounds to verbose, on both platforms. */
  @Test
  fun `a code just above zero is still verbose`() {
    assertEquals(android.util.Log.VERBOSE, NativeConsoleWriter.priorityOf(0.4))
    assertEquals(android.util.Log.VERBOSE, NativeConsoleWriter.priorityOf(-0.4))
  }

  /**
   * The largest double below a tie is not the tie, and must not be rounded as
   * one.
   *
   * This is the case that kills the usual `floor(v + 0.5)`:
   * `0.49999999999999994 + 0.5` is not representable and rounds up to exactly
   * `1.0`, so a flooring implementation answers DEBUG where iOS answers
   * VERBOSE — a level that differs between platforms for one specific double.
   */
  @Test
  fun `the double just below a tie does not round up`() {
    assertEquals(android.util.Log.VERBOSE,
                 NativeConsoleWriter.priorityOf(Math.nextDown(0.5)))
    assertEquals(android.util.Log.VERBOSE,
                 NativeConsoleWriter.priorityOf(Math.nextUp(-0.5)))
    assertEquals(android.util.Log.WARN,
                 NativeConsoleWriter.priorityOf(Math.nextDown(3.5)))
  }

  /** Past the top of the range there is no level to round to. */
  @Test
  fun `a code past the highest level falls back rather than escalating`() {
    assertEquals(android.util.Log.INFO, NativeConsoleWriter.priorityOf(5.6))
  }

  // MARK: - Chunking

  @Test
  fun `a line that fits is left alone`() {
    val line = "a short line"
    assertEquals(listOf(line), NativeConsoleWriter.chunks(line))
  }

  @Test
  fun `an empty line is still one entry`() {
    assertEquals(listOf(""), NativeConsoleWriter.chunks(""))
  }

  /** Exactly at the limit is not over it, and must not gain a marker. */
  @Test
  fun `the boundary is not split`() {
    val line = "x".repeat(NativeConsoleWriter.CHUNK_BYTES)
    assertEquals(listOf(line), NativeConsoleWriter.chunks(line))

    val over = "x".repeat(NativeConsoleWriter.CHUNK_BYTES + 1)
    assertTrue(NativeConsoleWriter.chunks(over).size > 1)
  }

  /**
   * The marker is part of the entry, so a piece sized to the limit and then
   * prefixed would be truncated by exactly the marker's width — losing the
   * end of a line while claiming to have preserved it.
   */
  @Test
  fun `every piece fits with its marker`() {
    val pieces = NativeConsoleWriter.chunks("y".repeat(NativeConsoleWriter.CHUNK_BYTES * 3))
    assertTrue(pieces.size > 1)
    for (piece in pieces) {
      assertTrue("a piece exceeded the entry limit: ${utf8(piece)}",
                 utf8(piece) <= NativeConsoleWriter.CHUNK_BYTES)
    }
  }

  @Test
  fun `the pieces reassemble into the original`() {
    val line = (0 until 500).joinToString(" ") { "token$it" }
    val pieces = NativeConsoleWriter.chunks(line)
    assertTrue(pieces.size > 1)

    val rejoined = pieces.joinToString("") { it.substringAfter(") ") }
    assertEquals(line, rejoined)
  }

  /** A reader has to be able to tell a continuation from a fresh entry. */
  @Test
  fun `pieces are numbered so a missing one is visible`() {
    val pieces = NativeConsoleWriter.chunks("z".repeat(NativeConsoleWriter.CHUNK_BYTES * 2))
    val total = pieces.size
    pieces.forEachIndexed { index, piece ->
      assertTrue("'$piece' is not marked", piece.startsWith("(${index + 1}/$total) "))
    }
  }

  /**
   * Cutting a surrogate pair in half produces replacement characters — visible
   * corruption in a log that was not corrupt.
   */
  @Test
  fun `splits fall on code point boundaries`() {
    // Four bytes each, so a boundary lands mid-character unless it is guarded.
    val line = "😀".repeat(NativeConsoleWriter.CHUNK_BYTES)
    val pieces = NativeConsoleWriter.chunks(line)

    for (piece in pieces) {
      val body = piece.substringAfter(") ")
      assertTrue("a piece starts with an orphaned low surrogate",
                 body.isEmpty() || !body.first().isLowSurrogate())
      assertTrue("a piece ends with an orphaned high surrogate",
                 body.isEmpty() || !body.last().isHighSurrogate())
      assertTrue("a piece contains a replacement character", !body.contains('�'))
    }
  }

  @Test
  fun `an enormous line is capped and says what was lost`() {
    val line = "q".repeat(NativeConsoleWriter.CHUNK_BYTES * 40)
    val pieces = NativeConsoleWriter.chunks(line)

    assertEquals(NativeConsoleWriter.MAX_CHUNKS, pieces.size)
    assertTrue("the cap is silent about what it dropped",
               pieces.last().contains("bytes truncated"))
  }

  /**
   * The one line here that must survive is the one reporting truncation, so it
   * has to fit inside its own entry rather than be appended past the limit.
   */
  @Test
  fun `the truncation notice fits inside its own entry`() {
    val pieces = NativeConsoleWriter.chunks("w".repeat(NativeConsoleWriter.CHUNK_BYTES * 40))
    val last = pieces.last()

    assertTrue(utf8(last) <= NativeConsoleWriter.CHUNK_BYTES)
    assertTrue(last.contains("bytes truncated"))
  }

  /** The number has to be the real shortfall, or it is worse than none. */
  @Test
  fun `the truncation count is the real shortfall`() {
    val line = "e".repeat(NativeConsoleWriter.CHUNK_BYTES * 40)
    val pieces = NativeConsoleWriter.chunks(line)

    val reported = Regex("""\+(\d+) bytes truncated""")
      .find(pieces.last())!!.groupValues[1].toInt()
    val kept = pieces.sumOf { utf8(it.substringAfter(") ")) } -
      utf8(" …+$reported bytes truncated")

    assertEquals(utf8(line), kept + reported)
  }

  /** A byte count is a length, not content. */
  @Test
  fun `the truncation notice carries no content`() {
    val secret = "PATIENT-9134"
    val line = "x".repeat(NativeConsoleWriter.CHUNK_BYTES * 40) + secret
    val notice = NativeConsoleWriter.chunks(line).last().substringAfter("…")

    assertTrue(!notice.contains(secret))
  }

  // MARK: - Batching

  /**
   * A short `levels` array is a caller bug; dropping the messages it does have
   * would turn that bug into missing logs.
   */
  @Test
  fun `a short levels array does not cost messages`() {
    val recorder = Recorder()
    NativeConsoleWriter(recorder.emit)
      .logBatch(doubleArrayOf(4.0), arrayOf("first", "second", "third"))

    assertEquals(3, recorder.entries.size)
    assertEquals(android.util.Log.ERROR, recorder.entries[0].first)
    assertEquals(android.util.Log.INFO, recorder.entries[1].first)
  }

  /**
   * Losing every line because a caller forgot a setup call is a worse failure
   * than logging under a guessed tag — and this is the diagnostic channel, the
   * one you reach for when something else has already gone wrong.
   */
  @Test
  fun `logging before install still goes somewhere`() {
    val recorder = Recorder()
    NativeConsoleWriter(recorder.emit).logBatch(doubleArrayOf(2.0), arrayOf("orphan"))

    assertEquals(1, recorder.entries.size)
    assertEquals(NativeConsoleWriter.FALLBACK_TAG, recorder.entries[0].second)
  }

  /** An empty tag produces entries nobody can filter for. */
  @Test
  fun `an empty category falls back to something searchable`() {
    val recorder = Recorder()
    val writer = NativeConsoleWriter(recorder.emit)
    writer.install("com.example.app", "")
    writer.logBatch(doubleArrayOf(2.0), arrayOf("line"))

    assertEquals(NativeConsoleWriter.FALLBACK_TAG, recorder.entries[0].second)
  }

  @Test
  fun `the installed category becomes the tag`() {
    val recorder = Recorder()
    val writer = NativeConsoleWriter(recorder.emit)
    writer.install("com.example.app", "network")
    writer.logBatch(doubleArrayOf(2.0), arrayOf("line"))

    assertEquals("network", recorder.entries[0].second)
  }

  /** A long line becomes several entries, not one truncated one. */
  @Test
  fun `a batch emits one entry per chunk`() {
    val recorder = Recorder()
    NativeConsoleWriter(recorder.emit).logBatch(
      doubleArrayOf(2.0), arrayOf("v".repeat(NativeConsoleWriter.CHUNK_BYTES * 2)))

    assertTrue(recorder.entries.size > 1)
    for (entry in recorder.entries) {
      assertTrue(utf8(entry.third) <= NativeConsoleWriter.CHUNK_BYTES)
    }
  }
}
