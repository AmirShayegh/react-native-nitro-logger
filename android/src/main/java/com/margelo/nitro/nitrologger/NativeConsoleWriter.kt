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
    tag = cappedTag(category.ifEmpty { FALLBACK_TAG })
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
      // The tag travels with the message into one entry and is charged against
      // the same budget — see [messageBudget].
      for (chunk in chunks(messages[i], tag)) emit(priority, tag, chunk)
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
     *
     * A ceiling on the message alone, not the whole budget: the tag is charged
     * against [ENTRY_BYTES] too, and a long one lowers the effective limit. See
     * [messageBudget].
     */
    const val CHUNK_BYTES = 3800

    /**
     * Tag plus message bytes this writer will put in one entry.
     *
     * logcat's payload is about 4 KB and holds the priority byte, the tag, the
     * message and a NUL after each of the last two. 4000 leaves ~96 bytes for
     * that framing, which is far more than it needs — the margin is there so a
     * device that accounts differently still fits.
     *
     * Counted the way the platform counts, not the way the caller wrote it:
     * every budget here is in **modified UTF-8**, which is what JNI hands to
     * native logcat. See [logcatLength].
     */
    const val ENTRY_BYTES = 4000

    /**
     * Longest tag this writer will store, in bytes.
     *
     * The category is caller-supplied and was previously stored verbatim, which
     * is what makes this a cap rather than a formality: nothing stopped a
     * 4 KB category from consuming the whole entry and truncating every line's
     * tail in silence — the exact failure the chunker exists to prevent.
     *
     * 256 is generous for a real reverse-DNS category and still small enough
     * that a filter expression stays typeable. logcat itself once capped tags
     * at 23 characters; it no longer does, but tooling still displays long ones
     * badly, so this is a limit callers are unlikely to meet by accident.
     *
     * Deliberately above `ENTRY_BYTES - CHUNK_BYTES` (200): a tag between those
     * two numbers is legal and shrinks the message budget instead of being
     * rejected, which is why [messageBudget] derives the limit rather than
     * assuming the reservation holds.
     */
    const val MAX_TAG_BYTES = 256

    /**
     * Message bytes available alongside [tag] — the reservation, computed.
     *
     * [CHUNK_BYTES] is the ceiling; a tag longer than the ~200 bytes that
     * ceiling implicitly reserved lowers it byte for byte, so tag + message
     * never exceeds [ENTRY_BYTES]. For every ordinary tag this is exactly
     * [CHUNK_BYTES] and nothing about the split changes.
     */
    fun messageBudget(tag: String): Int = minOf(CHUNK_BYTES, ENTRY_BYTES - logcatLength(tag))

    /**
     * [category] cut to [MAX_TAG_BYTES], on a code point boundary.
     *
     * Cutting mid-code-point would hand logcat a tag ending in a partial UTF-8
     * sequence, which renders as a replacement character and, worse, cannot be
     * typed back into a filter expression.
     */
    fun cappedTag(category: String): String {
      if (logcatLength(category) <= MAX_TAG_BYTES) return category
      val kept = StringBuilder()
      var bytes = 0
      var i = 0
      while (i < category.length) {
        val codePoint = category.codePointAt(i)
        val width = logcatWidth(codePoint)
        if (bytes + width > MAX_TAG_BYTES) break
        val charCount = Character.charCount(codePoint)
        kept.appendRange(category, i, i + charCount)
        bytes += width
        i += charCount
      }
      return kept.toString()
    }

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
     * A single code point wider than a whole chunk cannot occur — six bytes at
     * most as logcat counts them (see [logcatLength]), against a budget in the
     * thousands.
     *
     * [tag] is charged against the same entry, so it is what the limit is
     * computed from — see [messageBudget]. It defaults to [FALLBACK_TAG]
     * because most callers here are asking about the split itself, and that is
     * the shortest tag any entry can carry.
     */
    fun chunks(message: String, tag: String = FALLBACK_TAG): List<String> {
      val limit = messageBudget(tag)
      if (logcatLength(message) <= limit) return listOf(message)

      // Reserve room for the widest marker any of these pieces can carry, so
      // adding the prefix cannot push a piece back over the limit.
      val budget = limit - MARKER_WIDTH
      val pieces = mutableListOf<String>()
      val current = StringBuilder()
      var currentBytes = 0

      var i = 0
      while (i < message.length) {
        val codePoint = message.codePointAt(i)
        val charCount = Character.charCount(codePoint)
        val width = logcatWidth(codePoint)

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
      var remaining = logcatLength(message) - pieces.sumOf { logcatLength(it) }
      if (remaining > 0 && pieces.isNotEmpty()) {
        val last = StringBuilder(pieces.removeAt(pieces.size - 1))
        // Make room for the notice inside the entry rather than appending past
        // the limit — otherwise logcat truncates the very sentence that exists
        // to report truncation, which is the one line here that must survive.
        // Each code point given back grows the count it reports.
        while (logcatLength(last) + NOTICE_WIDTH + MARKER_WIDTH > limit && last.isNotEmpty()) {
          val dropped = last.codePointBefore(last.length)
          last.setLength(last.length - Character.charCount(dropped))
          remaining += logcatWidth(dropped)
        }
        last.append(" …+$remaining bytes truncated")
        pieces.add(last.toString())
      }

      val total = pieces.size
      return pieces.mapIndexed { index, piece -> "(${index + 1}/$total) $piece" }
    }

    /** `"(8/8) "` — the widest prefix [MAX_CHUNKS] can produce. */
    private val MARKER_WIDTH = logcatLength("($MAX_CHUNKS/$MAX_CHUNKS) ")

    /**
     * The truncation notice at its widest, so reserving this much is always
     * enough however large the count turns out to be.
     */
    private val NOTICE_WIDTH = logcatLength(" …+${Int.MAX_VALUE} bytes truncated")

    /**
     * Byte length **as logcat will count it**, computed rather than measured.
     *
     * Not standard UTF-8, and the difference is the whole reason this is a
     * function rather than `toByteArray().size`. `Log.println` hands the tag
     * and the message to native code through JNI's `GetStringUTFChars`, which
     * produces **modified UTF-8**: a supplementary code point crosses as its
     * two surrogates encoded separately — six bytes, not four — and U+0000
     * crosses as the two-byte `C0 80` rather than a NUL that would terminate
     * the C string early.
     *
     * Budgeting in standard UTF-8 therefore undercounts an emoji-heavy line by
     * half again, which is exactly enough to push a "safely under 4 KB" entry
     * past the limit and have logcat drop its tail in silence — the failure
     * this whole file exists to prevent. Measuring what the caller wrote is not
     * the same as measuring what the platform stores, and only the second one
     * is a budget.
     *
     * `toByteArray()` would also encode the whole string to answer a question
     * about its length, on every code point of every oversized line — and it
     * would answer the wrong question.
     */
    fun logcatLength(text: CharSequence): Int {
      var bytes = 0
      var i = 0
      while (i < text.length) {
        val codePoint = Character.codePointAt(text, i)
        bytes += logcatWidth(codePoint)
        i += Character.charCount(codePoint)
      }
      return bytes
    }

    /** One code point's cost in modified UTF-8. See [logcatLength]. */
    private fun logcatWidth(codePoint: Int): Int = when {
      // The one case where modified UTF-8 is *wider* than plain ASCII.
      codePoint == 0 -> 2
      codePoint < 0x80 -> 1
      codePoint < 0x800 -> 2
      codePoint < 0x10000 -> 3
      // Two three-byte surrogates, not a four-byte sequence.
      else -> 6
    }
  }
}
