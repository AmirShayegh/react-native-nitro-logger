package com.margelo.nitro.nitrologger

import com.facebook.proguard.annotations.DoNotStrip

/**
 * Routes pre-formatted lines into logcat so JS entries interleave with
 * native ones. Tag = the installed category.
 *
 * Marshalling only. The level map and the chunking that keeps logcat from
 * silently eating the tail of a long line live in [NativeConsoleWriter], which
 * imports nothing from Nitro and is therefore testable — the same split the
 * file sink uses, and for the same reason.
 */
@DoNotStrip
class HybridNativeConsoleSink : HybridNativeConsoleSinkSpec() {
  private val writer = NativeConsoleWriter()

  override fun install(subsystem: String, category: String) =
    writer.install(subsystem, category)

  override fun logBatch(levels: DoubleArray, messages: Array<String>) =
    writer.logBatch(levels, messages)
}
