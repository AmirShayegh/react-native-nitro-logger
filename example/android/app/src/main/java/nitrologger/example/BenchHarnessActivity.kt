package nitrologger.example

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * Hosts the Hermes bench mirror, and nothing else.
 *
 * A separate activity for the same reason as [C13HarnessActivity]: the
 * harness must not share a screen with whatever the example app is doing.
 * Unlike C13 this one is `exported="true"` — `scripts/bench-hermes-android.sh`
 * starts it with a plain `am start`, which cannot reach a non-exported
 * activity — and what that exposes is an activity that benchmarks library
 * code and prints timings, nothing more.
 *
 * The launch options forward the intent's extras to the component, which is
 * how the script's per-run ID (`--es benchRunId <id>`) reaches the JS side.
 * The ID is what lets the script tell THIS run's logcat lines from a stale
 * buffer's.
 */
class BenchHarnessActivity : ReactActivity() {
  override fun getMainComponentName(): String = "BenchHarness"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
        override fun getLaunchOptions(): Bundle? = intent?.extras
      }
}
