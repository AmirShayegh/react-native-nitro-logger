package com.margelo.nitro.nitrologger

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers exactly one module, and it is not one JavaScript ever calls.
 *
 * Every API this package exposes crosses through Nitro, so this used to register
 * nothing at all. [NitroLoggerLifecycle] is here for its `invalidate()`
 * callback — the signal that a React instance has been destroyed, and with it
 * the JavaScript that would otherwise have closed the writers it opened. See
 * [ReactInstanceEpoch].
 */
class NitroLoggerPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
        return if (name == NitroLoggerLifecycle.NAME) {
            NitroLoggerLifecycle(reactContext)
        } else {
            null
        }
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        return ReactModuleInfoProvider {
            mapOf(
                NitroLoggerLifecycle.NAME to ReactModuleInfo(
                    NitroLoggerLifecycle.NAME,
                    NitroLoggerLifecycle.NAME,
                    // canOverrideExistingModule
                    false,
                    // needsEagerInit — load-bearing. Nothing in JavaScript ever
                    // calls this module, so lazily it would never be created,
                    // never initialized and never invalidated: present, and
                    // silently doing nothing.
                    true,
                    // isCxxModule
                    false,
                    // isTurboModule — the app's, not ours to assume. On the old
                    // architecture a module flagged as one is looked for in a
                    // TurboModuleManager that is not there, and this would be
                    // registered and never created: the same silent nothing
                    // `needsEagerInit` is here to prevent.
                    BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
                )
            )
        }
    }

    companion object {
        init {
            System.loadLibrary("nitrologger")
        }
    }
}
