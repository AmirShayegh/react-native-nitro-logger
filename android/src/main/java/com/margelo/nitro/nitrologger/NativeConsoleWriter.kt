package com.margelo.nitro.nitrologger

import android.util.Log

/**
 * The logcat bridge, minus Nitro.
 *
 * Everything worth getting wrong here — the level map, and what happens to a
 * line longer than logcat will store — is a pure function of its input, so it
 * lives where JUnit can reach it. [HybridNativeConsoleSink] is the adapter
 * around this and holds no logic of its own. The iOS twin,
 * `NativeConsoleWriter.swift`, is split the same way for the same reason.
 *
 * [emit] exists so the tests can watch what would have gone to logcat.
 * `android.util.Log` is a stub under unit tests that swallows everything and
 * returns zero, so a writer that called it directly could only ever be tested
 * by not testing it.
 */
class NativeConsoleWriter(private val emit: (Int, String, String) -> Unit = LOGCAT) {

  @Volatile
  private var tag: String = FALLBACK_TAG

  /** Binds the tag. Calling it again rebinds. */
  fun install(subsystem: String, category: String) {
    // logcat has no subsystem dimension, so the category becomes the tag and
    // the subsystem is deliberately unused — it is already in the rendered
    // line. An empty category would produce entries nobody can filter for.
    tag = category.ifEmpty { FALLBACK_TAG }
  }

  /**
   * Writes one drained batch.
   *
   * `levels` and `messages` are parallel arrays rather than an array of
   * structs, which keeps a batch to two bridge crossings instead of one per
   * entry. `messages` is authoritative on count: a short `levels` means the
   * caller has a bug, and dropping the messages it does have would turn that
   * bug into missing logs.
   */
  fun logBatch(levels: DoubleArray, messages: Array<String>) {
    if (messages.isEmpty()) return
    val tag = this.tag
    for (i in messages.indices) {
      val priority = priorityOf(if (i < levels.size) levels[i] else 2.0)
      for (chunk in chunks(messages[i])) emit(priority, tag, chunk)
    }
  }

  companion object {
    /**
     * Bytes of message text per logcat entry.
     *
     * logcat's per-entry payload is about 4 KB and the rest is dropped in
     * silence — no ellipsis, no diagnostic, the tail simply is not there. For a
     * logger that is the worst kind of failure: the console shows a complete-
     * looking line that is missing the half you needed. 3800 leaves room under
     * the limit for the tag, the priority byte and logcat's own framing.
     *
     * Lower than the iOS 900 because the two platforms' limits genuinely
     * differ; the *behaviour* around the limit is what is kept identical.
     */
    const val CHUNK_BYTES = 3800

    /**
     * At most this many chunks per line. A stack trace should arrive whole; a
     * runaway 4 MB string should not become a thousand logcat entries.
     */
    const val MAX_CHUNKS = 8

    /** Used when nothing installed a category, so entries stay findable. */
    const val FALLBACK_TAG = "NitroLogger"

    private val LOGCAT: (Int, String, String) -> Unit = { priority, tag, message ->
      Log.println(priority, tag, message)
    }

    /**
     * Codes 0–5 (verbose…todo), matching `LEVEL_ORDER` in TypeScript.
     *
     * Matched on the `Double` rather than converted first. Levels arrive as
     * `Double` because that is what JavaScript has, and `toInt()` does not
     * report a bad one — it saturates, so `NaN` becomes 0 and would log a
     * corrupt level as `VERBOSE`, the one priority most likely to be filtered
     * out entirely.
     *
     * A near-integer code is *rounded*, not rejected: 3.6 is a level 4 that
     * survived a float round trip, and iOS has always read it that way. Only a
     * code that rounds to nothing in 0–5 — negative, enormous, `NaN` — is
     * `INFO`. It carries no trustworthy severity, so it is shown rather than
     * hidden as `VERBOSE` or escalated to `ASSERT`. The rendered line still
     * carries its own level tag either way. iOS answers `.default` here.
     *
     * Not `Math.round`, which is half-*up*: it rounds -0.5 to 0 and -1.5 to -1,
     * where Swift's `.rounded()` is half-*away-from-zero* and answers -1 and -2.
     * The two agree on everything except a negative tie, and a level map that
     * disagrees across platforms on any input is the kind of difference nobody
     * can reproduce from a bug report.
     */
    fun priorityOf(code: Double): Int {
      if (code.isNaN()) return Log.INFO
      return when (roundHalfAwayFromZero(code)) {
        0.0 -> Log.VERBOSE
        1.0 -> Log.DEBUG
        2.0 -> Log.INFO
        3.0 -> Log.WARN
        4.0 -> Log.ERROR
        5.0 -> Log.ASSERT // todo → highest visibility, mirrors os_log .fault
        else -> Log.INFO
      }
    }

    /**
     * Swift's default rounding rule, which this has to match exactly.
     *
     * Written as "is the fraction at least a half" rather than the usual
     * `floor(v + 0.5)`, because that shortcut is wrong just below every tie:
     * `0.49999999999999994 + 0.5` is not representable and rounds *up* to
     * exactly `1.0`, so the floor answers 1 where Swift answers 0. Comparing
     * the fraction never adds across the boundary and so cannot invent one.
     *
     * Infinities survive as infinities and so match no level, which is what
     * sends them to `INFO`. Above 2^52 every double is already an integer, the
     * fraction is zero, and this returns the value unchanged.
     */
    private fun roundHalfAwayFromZero(value: Double): Double {
      val magnitude = Math.abs(value)
      val lower = Math.floor(magnitude)
      val rounded = if (magnitude - lower >= 0.5) lower + 1.0 else lower
      return Math.copySign(rounded, value)
    }

    /**
     * Splits a line into pieces logcat will store whole.
     *
     * A line that already fits comes back untouched and unmarked — the common
     * case must look exactly as it was rendered. Only when splitting is
     * unavoidable does each piece get an `(i/n)` prefix, so a reader can tell a
     * continuation from a fresh entry and can see when one is missing.
     *
     * Splits fall on code point boundaries, never inside a surrogate pair:
     * cutting an emoji in half produces replacement characters in logcat and,
     * worse, suggests corruption that is not there. This is a shade weaker than
     * the iOS twin, which splits on grapheme clusters and so also keeps
     * combining sequences together — reaching that here means `BreakIterator`
     * and an ICU version that varies by device, for a case that renders
     * oddly rather than corruptly. `docs/PARITY.md` records the difference.
     *
     * A single code point wider than a whole chunk cannot occur — four bytes at
     * most, against a budget in the thousands.
     */
    fun chunks(message: String): List<String> {
      if (utf8Length(message) <= CHUNK_BYTES) return listOf(message)

      // Reserve room for the widest marker any of these pieces can carry, so
      // adding the prefix cannot push a piece back over the limit.
      val budget = CHUNK_BYTES - MARKER_WIDTH
      val pieces = mutableListOf<String>()
      val current = StringBuilder()
      var currentBytes = 0

      var i = 0
      while (i < message.length) {
        val codePoint = message.codePointAt(i)
        val charCount = Character.charCount(codePoint)
        val width = utf8Width(codePoint)

        if (currentBytes + width > budget && current.isNotEmpty()) {
          pieces.add(current.toString())
          current.setLength(0)
          currentBytes = 0
          if (pieces.size == MAX_CHUNKS) break
        }
        current.appendRange(message, i, i + charCount)
        currentBytes += width
        i += charCount
      }

      if (pieces.size < MAX_CHUNKS && current.isNotEmpty()) pieces.add(current.toString())

      // Whatever is left over after the chunk ceiling is announced by size
      // rather than dropped in silence. A byte count is a length, not content,
      // so it says nothing about what was in the line.
      var remaining = utf8Length(message) - pieces.sumOf { utf8Length(it) }
      if (remaining > 0 && pieces.isNotEmpty()) {
        val last = StringBuilder(pieces.removeAt(pieces.size - 1))
        // Make room for the notice inside the entry rather than appending past
        // the limit — otherwise logcat truncates the very sentence that exists
        // to report truncation, which is the one line here that must survive.
        // Each code point given back grows the count it reports.
        while (utf8Length(last) + NOTICE_WIDTH + MARKER_WIDTH > CHUNK_BYTES && last.isNotEmpty()) {
          val dropped = last.codePointBefore(last.length)
          last.setLength(last.length - Character.charCount(dropped))
          remaining += utf8Width(dropped)
        }
        last.append(" …+$remaining bytes truncated")
        pieces.add(last.toString())
      }

      val total = pieces.size
      return pieces.mapIndexed { index, piece -> "(${index + 1}/$total) $piece" }
    }

    /** `"(8/8) "` — the widest prefix [MAX_CHUNKS] can produce. */
    private val MARKER_WIDTH = utf8Length("($MAX_CHUNKS/$MAX_CHUNKS) ")

    /**
     * The truncation notice at its widest, so reserving this much is always
     * enough however large the count turns out to be.
     */
    private val NOTICE_WIDTH = utf8Length(" …+${Int.MAX_VALUE} bytes truncated")

    /**
     * UTF-8 byte length, computed rather than measured.
     *
     * `toByteArray()` would encode the whole string to answer a question about
     * its length, on every code point of every oversized line.
     */
    private fun utf8Length(text: CharSequence): Int {
      var bytes = 0
      var i = 0
      while (i < text.length) {
        val codePoint = Character.codePointAt(text, i)
        bytes += utf8Width(codePoint)
        i += Character.charCount(codePoint)
      }
      return bytes
    }

    private fun utf8Width(codePoint: Int): Int = when {
      codePoint < 0x80 -> 1
      codePoint < 0x800 -> 2
      codePoint < 0x10000 -> 3
      else -> 4
    }
  }
}
