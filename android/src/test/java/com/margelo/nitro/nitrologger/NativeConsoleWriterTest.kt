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

  /**
   * What logcat is actually handed, counted independently of the writer.
   *
   * Deliberately **not** `NativeConsoleWriter.logcatLength` — a budget test
   * that measures with the same function the budget is computed from proves
   * only that the code agrees with itself. This walks the string the way JNI's
   * `GetStringUTFChars` does: modified UTF-8, so each surrogate is encoded on
   * its own (three bytes each, six for the pair) and U+0000 becomes `C0 80`.
   *
   * Against plain `toByteArray(UTF_8)` the two differ on exactly the inputs
   * that matter here, which is why the emoji cases below would pass while a
   * real entry lost its tail.
   */
  private fun logcatBytes(text: String): Int {
    var bytes = 0
    for (unit in text) {
      bytes += when {
        unit.code == 0 -> 2
        unit.code < 0x80 -> 1
        unit.code < 0x800 -> 2
        else -> 3 // includes each half of a surrogate pair, counted separately
      }
    }
    return bytes
  }

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
      assertTrue("a piece exceeded the entry limit: ${logcatBytes(piece)}",
                 logcatBytes(piece) <=
                   NativeConsoleWriter.messageBudget(NativeConsoleWriter.FALLBACK_TAG))
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

    // Every assertion below holds for a chunker that returned the line whole,
    // so without this the test passes while splitting nothing — the exact
    // vacuous pass a boundary test cannot afford.
    assertTrue("nothing was split, so the boundary rule was never exercised",
               pieces.size > 1)

    for (piece in pieces) {
      val body = piece.substringAfter(") ")
      // In the encoding the limit is defined in. These pieces are emoji, where
      // standard UTF-8 reports four bytes for what logcat stores as six — so
      // measuring the standard way would let an oversized piece through.
      assertTrue("a piece exceeded the entry limit: ${logcatBytes(piece)}",
                 logcatBytes(piece) <=
                   NativeConsoleWriter.messageBudget(NativeConsoleWriter.FALLBACK_TAG))
      assertTrue("a piece starts with an orphaned low surrogate",
                 body.isEmpty() || !body.first().isLowSurrogate())
      assertTrue("a piece ends with an orphaned high surrogate",
                 body.isEmpty() || !body.last().isHighSurrogate())
      assertTrue("a piece contains a replacement character", !body.contains('�'))
      // The bytes that came back have to be the bytes that were asked for: a
      // piece that survives a UTF-8 round trip unchanged cannot be holding
      // half a code point, whatever the surrogate checks above do or do not
      // catch at its two ends.
      assertEquals("a piece did not survive a UTF-8 round trip",
                   body, String(body.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
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

    assertTrue(logcatBytes(last) <=
                 NativeConsoleWriter.messageBudget(NativeConsoleWriter.FALLBACK_TAG))
    assertTrue(last.contains("bytes truncated"))
  }

  /** The number has to be the real shortfall, or it is worse than none. */
  @Test
  fun `the truncation count is the real shortfall`() {
    val line = "e".repeat(NativeConsoleWriter.CHUNK_BYTES * 40)
    val pieces = NativeConsoleWriter.chunks(line)

    val reported = Regex("""\+(\d+) bytes truncated""")
      .find(pieces.last())!!.groupValues[1].toInt()
    // The count the writer reports is in its own units, so the arithmetic that
    // checks it has to be too.
    val kept = pieces.sumOf { logcatBytes(it.substringAfter(") ")) } -
      logcatBytes(" …+$reported bytes truncated")

    assertEquals(logcatBytes(line), kept + reported)
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
      assertTrue(logcatBytes(entry.third) <=
                   NativeConsoleWriter.messageBudget(NativeConsoleWriter.FALLBACK_TAG))
    }
  }

  // MARK: - The tag is part of the budget

  /**
   * The category is caller-supplied and was stored verbatim, so a long one used
   * to eat the headroom the chunk size reserves and truncate every line's tail
   * in silence — the failure the chunker exists to prevent.
   */
  @Test
  fun `a caller-supplied tag cannot eat the entry budget`() {
    val recorder = Recorder()
    val writer = NativeConsoleWriter(recorder.emit)
    writer.install("com.example.app", "t".repeat(NativeConsoleWriter.CHUNK_BYTES))
    writer.logBatch(doubleArrayOf(2.0), arrayOf("w".repeat(NativeConsoleWriter.CHUNK_BYTES)))

    assertTrue(recorder.entries.isNotEmpty())
    for ((_, tag, message) in recorder.entries) {
      assertTrue("the stored tag was ${logcatBytes(tag)} bytes",
                 logcatBytes(tag) <= NativeConsoleWriter.MAX_TAG_BYTES)
      assertTrue("tag and message together were ${logcatBytes(tag) + logcatBytes(message)} bytes",
                 logcatBytes(tag) + logcatBytes(message) <= NativeConsoleWriter.ENTRY_BYTES)
    }
  }

  /**
   * The bytes that matter are the ones JNI produces, not the ones
   * `String.toByteArray()` would.
   *
   * `Log.println` crosses through `GetStringUTFChars`, which encodes each
   * surrogate separately: an emoji costs six bytes there and four in standard
   * UTF-8. A budget computed the standard way lets an all-emoji tag and line
   * through at 1.5× the payload they were measured at, and logcat drops the
   * difference in silence. This is the case that says so — every assertion is
   * in modified-UTF-8 bytes, counted here rather than borrowed from the writer.
   */
  @Test
  fun `an emoji tag and line are budgeted in the bytes logcat receives`() {
    val recorder = Recorder()
    val writer = NativeConsoleWriter(recorder.emit)
    // 400 emoji: 1600 standard bytes, 2400 as logcat counts them — so a
    // standard-UTF-8 cap of 256 would have stored ~64 of them and a
    // modified-UTF-8 cap stores ~42.
    writer.install("com.example.app", "😀".repeat(400))
    writer.logBatch(doubleArrayOf(2.0), arrayOf("😀".repeat(2_000)))

    assertTrue(recorder.entries.isNotEmpty())
    for ((_, tag, message) in recorder.entries) {
      assertTrue("the stored tag was ${logcatBytes(tag)} bytes to logcat",
                 logcatBytes(tag) <= NativeConsoleWriter.MAX_TAG_BYTES)
      assertTrue("the entry was ${logcatBytes(tag) + logcatBytes(message)} bytes to logcat",
                 logcatBytes(tag) + logcatBytes(message) <= NativeConsoleWriter.ENTRY_BYTES)
      // The measurement the writer itself uses has to agree with an
      // independent count, or the budget is right about the wrong number.
      assertEquals(logcatBytes(message), NativeConsoleWriter.logcatLength(message))
    }
  }

  /**
   * U+0000 is the other place the two encodings disagree: JNI writes it as the
   * two-byte `C0 80` so it cannot terminate the C string early.
   */
  @Test
  fun `a NUL costs two bytes, the way JNI writes it`() {
    assertEquals(2, NativeConsoleWriter.logcatLength("\u0000"))
    assertEquals(2, logcatBytes("\u0000"))
    assertEquals(6, NativeConsoleWriter.logcatLength("😀"))
    assertEquals(3, NativeConsoleWriter.logcatLength("€"))
    assertEquals(1, NativeConsoleWriter.logcatLength("a"))
  }

  /**
   * The boundary where the two encodings disagree about FITTING, not just
   * about size: 634 emoji are 2,536 standard-UTF-8 bytes — comfortably under
   * the 3,800 budget — and 3,804 as logcat counts them, four over. A fit
   * check that priced supplementary code points at their standard width
   * would declare this line whole, emit it unsplit, and logcat would drop
   * the tail. The emoji case above cannot see that: its line is over budget
   * in both encodings, so it splits either way.
   */
  @Test
  fun `a line that fits in standard UTF-8 but not as logcat counts is still split`() {
    val recorder = Recorder()
    val writer = NativeConsoleWriter(recorder.emit)
    val line = "😀".repeat(634)
    writer.logBatch(doubleArrayOf(2.0), arrayOf(line))

    assertTrue("the line must be split, saw ${recorder.entries.size} entries",
               recorder.entries.size > 1)
    for ((_, _, message) in recorder.entries) {
      assertTrue("a piece was ${logcatBytes(message)} bytes to logcat",
                 logcatBytes(message) <= NativeConsoleWriter.CHUNK_BYTES)
    }
    assertEquals("every emoji still arrives, in order", line,
                 recorder.entries.joinToString("") { (_, _, message) ->
                   message.substringAfter(") ")
                 })
  }

  /**
   * The tail is preserved by splitting earlier, not by dropping it. A budget
   * that ignored the tag would return this line as one entry that logcat then
   * cuts short.
   */
  @Test
  fun `a long tag lowers the message budget rather than costing the tail`() {
    val tag = "c".repeat(NativeConsoleWriter.MAX_TAG_BYTES)
    val line = "m".repeat(NativeConsoleWriter.CHUNK_BYTES)
    val pieces = NativeConsoleWriter.chunks(line, tag)

    assertTrue("a line that no longer fits was not split", pieces.size > 1)
    assertEquals(line, pieces.joinToString("") { it.substringAfter(") ") })
    for (piece in pieces) {
      assertTrue("tag and piece together were ${logcatBytes(tag) + logcatBytes(piece)} bytes",
                 logcatBytes(tag) + logcatBytes(piece) <= NativeConsoleWriter.ENTRY_BYTES)
    }
  }

  /** Ordinary tags change nothing about the split. */
  @Test
  fun `a short tag leaves the message budget at the ceiling`() {
    assertEquals(NativeConsoleWriter.CHUNK_BYTES, NativeConsoleWriter.messageBudget("network"))
    val line = "x".repeat(NativeConsoleWriter.CHUNK_BYTES)
    assertEquals(listOf(line), NativeConsoleWriter.chunks(line, "network"))
  }

  /**
   * A tag ending in a partial UTF-8 sequence renders as a replacement
   * character and cannot be typed back into a filter expression.
   */
  @Test
  fun `a capped tag ends on a code point boundary`() {
    val category = "😀".repeat(NativeConsoleWriter.MAX_TAG_BYTES)
    val capped = NativeConsoleWriter.cappedTag(category)

    assertTrue(logcatBytes(capped) <= NativeConsoleWriter.MAX_TAG_BYTES)
    assertTrue("the cap dropped everything", capped.isNotEmpty())
    assertTrue("the cap did not keep a prefix of what was asked for",
               category.startsWith(capped))
    assertTrue("the tag ends in an orphaned high surrogate", !capped.last().isHighSurrogate())
    assertEquals("the tag did not survive a UTF-8 round trip",
                 capped, String(capped.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
  }

  /** A category that already fits is stored as it was written. */
  @Test
  fun `a tag at the cap is left alone`() {
    val category = "n".repeat(NativeConsoleWriter.MAX_TAG_BYTES)
    assertEquals(category, NativeConsoleWriter.cappedTag(category))
  }
}
