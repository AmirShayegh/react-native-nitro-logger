package nitrologger.example

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * Hosts the C13 reload harness, and nothing else.
 *
 * A separate activity rather than a flag on [MainActivity] because the test
 * drives this one through `ActivityScenario` and must not be looking at
 * whatever the example app's own screen is doing. `exported="false"` in the
 * manifest: nothing outside this package has any business starting it.
 *
 * Default launch mode, unlike [MainActivity]'s `singleTask` — `ActivityScenario`
 * expects to own the instance it launches.
 */
class C13HarnessActivity : ReactActivity() {
  override fun getMainComponentName(): String = "C13ReloadHarness"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
