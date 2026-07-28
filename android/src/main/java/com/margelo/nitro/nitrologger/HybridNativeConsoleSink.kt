package com.margelo.nitro.nitrologger

import android.util.Log
import com.facebook.proguard.annotations.DoNotStrip

/**
 * Routes pre-formatted lines into logcat so JS entries interleave with
 * native ones. Tag = the installed category.
 */
@DoNotStrip
class HybridNativeConsoleSink : HybridNativeConsoleSinkSpec() {
  private var tag: String = "NitroLogger"

  override fun install(subsystem: String, category: String) {
    // logcat has no subsystem dimension; category becomes the tag.
    tag = category
  }

  override fun logBatch(levels: DoubleArray, messages: Array<String>) {
    for (i in messages.indices) {
      val code = if (i < levels.size) levels[i].toInt() else 2
      val priority = when (code) {
        0 -> Log.VERBOSE
        1 -> Log.DEBUG
        2 -> Log.INFO
        3 -> Log.WARN
        4 -> Log.ERROR
        else -> Log.ASSERT // todo → highest visibility, mirrors os_log .fault
      }
      Log.println(priority, tag, messages[i])
    }
  }
}
