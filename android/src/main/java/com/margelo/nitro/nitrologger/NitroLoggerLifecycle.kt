package com.margelo.nitro.nitrologger

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.turbomodule.core.interfaces.TurboModule

/**
 * The only thing in this package that knows a React instance exists.
 *
 * It has one job: tell [ReactInstanceEpoch] when an instance starts and when it
 * is destroyed. Everything that follows from that — which handles belong to
 * which instance, what a sweep closes, what a dead owner's acquisition gets — is
 * plain Kotlin next door, where a JVM test can reach it.
 *
 * **`invalidate()` is the signal, and the choice matters.** `SPIKE-C13.md`
 * proposed `ReactContext.addLifecycleEventListener`, which carries *Activity*
 * lifecycle — `onHostResume`, `onHostPause`, `onHostDestroy` — and a reload
 * fires none of them: the Activity survives, only the instance underneath it is
 * replaced. `NativeModule.invalidate()` fires on exactly instance teardown, on
 * both architectures: bridgeless, `ReactInstance` destruction calls
 * `TurboModuleManager.invalidate()`, which invalidates every module it
 * instantiated; on the bridge, `CatalystInstance.destroy()` reaches the same
 * callback.
 *
 * **It must be eagerly initialized.** Nothing in JavaScript calls this module,
 * so under lazy initialization it would never be created, `initialize()` would
 * never run, and `invalidate()` would never fire — the module would exist and do
 * nothing, which is the failure mode hardest to notice. `NitroLoggerPackage`
 * declares it with `needsEagerInit = true` for that reason.
 */
internal class NitroLoggerLifecycle(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), TurboModule {

  /**
   * Set in [initialize] rather than at construction. A module is constructed
   * before it is initialized, and it is `initialize` that means "this instance
   * is running" — a constructed-but-never-initialized module is one whose
   * `invalidate` may still be called, and ending an epoch that never began
   * would be a claim about a runtime that never ran.
   */
  private var token: Long? = null

  override fun getName(): String = NAME

  override fun initialize() {
    super.initialize()
    token = ReactInstanceEpoch.begin()
  }

  override fun invalidate() {
    // Before `super`, which is where React Native tears the rest of the module
    // down. Sweeping first means the writers this instance opened are released
    // while the instance is still coherent, rather than during whatever follows.
    token?.let {
      token = null
      ReactInstanceEpoch.end(it)
    }
    super.invalidate()
  }

  internal companion object {
    const val NAME = "NitroLoggerLifecycle"
  }
}
