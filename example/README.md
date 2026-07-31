# The device harness

This is not a demo app. It is the part of the test suite that only a device can
run, and `src/App.tsx` is the harness rather than a showcase.

Everything else in this repository tests the library somewhere convenient. The
Swift and Kotlin suites run the two native writers on a Mac and a desktop JVM in
a couple of seconds each; the Jest suite runs the TypeScript core in Node. All
three deliberately avoid the device. What none of them can answer is whether the
same code works **through Hermes and the Nitro bridge**, against the real
`Library/Logs` / `noBackupFilesDir`, under iOS data protection, and into the
unified log where Console.app can actually see it.

So the harness drives the real pipeline —

```
Log → FileDestination → Batcher → Nitro → LogWriter        (the file leg)
Log → NativeConsoleDestination → Nitro → os_log / logcat   (the console leg)
```

— runs on mount, and prints one greppable verdict line so a pass can be driven
from a shell instead of by tapping. Tapping **Run again** re-runs it.

## Running it

```sh
yarn                      # from the repository root
yarn example start        # Metro
yarn example ios          # or: yarn example android
```

iOS needs pods the first time and after any native change:

```sh
cd example/ios && bundle install && bundle exec pod install
```

The verdict is on screen, and also in the platform log. Reading it from the
shell is the point:

```sh
# iOS — the os_log leg, which is the only way to prove it from outside the app
xcrun simctl spawn <udid> log show --last 2m \
  --predicate 'subsystem == "nitrologger.example.harness"'

# Android — Hermes routes console.log to the `ReactNativeJS` tag, so filter on
# the tag and grep for the sentinel, not the other way round
adb logcat -d -s ReactNativeJS:V | grep NITRO_M6
```

A line starting `PASS` means every step passed; each step is also listed on
screen with its own detail, so a failure names itself.

## The sentinels, and what checks them

Three constants in `src/App.tsx` are load-bearing, and two of them are checked
by a script rather than by the app — because the app cannot check them about
itself:

- `NITRO_PRIVACY_SENTINEL_9f3a` is written through `priv()`. In a **release**
  bundle that string must not reach the log file; `<private>` must be there
  instead. `scripts/check-release-bundle.sh` is what asserts it, by building a
  release bundle and inspecting it.
- `NITRO_ERROR_SENTINEL_7c21` is thrown through the real `ErrorUtils` hook.
  Neither it nor its custom class name may appear in the log in **any** build —
  the sanitiser strips both regardless of `__DEV__`.
- `NITRO_M6` is the verdict prefix the commands above grep for.

Changing a sentinel here means changing it there. They are asserted equal
between the two, so a rename fails rather than silently disarming a check.

## `C13ReloadHarness.tsx`

A second, narrower harness for one specific failure: what happens to an open
file handle across a Fast Refresh reload, when JavaScript state is discarded but
the native writer is not. `scripts/check-android-reload.sh` drives it.

## If it does not launch

The four setup requirements in the [root README](../README.md#setup) — the
`react-native-nitro-modules` peer, New Architecture, `pod install`, JDK 17 —
produce the same runtime error here as in any consumer app. That section has the
message and how to tell the causes apart.
