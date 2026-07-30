---
'react-native-nitro-logger': patch
---

Android's React Native ≥ 0.78 claim is now verified, not narrowed.

Since 0.1.0 the compatibility table said one thing for iOS and a weaker thing
for Android: `min-rn-ios` packs a tarball into a pristine 0.78 app, builds it
Release and launches it, while Android had `test-android` (the writer's JUnit
suite) and `build-android` (the example, on the newest React Native) and
nothing that asked whether a consumer on the bottom of the range could install
the package at all. The claim was narrowed to "0.78 experimental" rather than
asserted, which was the honest option available at the time.

`min-rn-android` closes it. Same shape as the iOS job — `yarn pack`, scaffold
0.78 from the community template, install the tarball, open a file sink, write
500 records, flush, list, purge — built Release for the emulator's own ABI and
launched on API 34.

The one difference is how the verdict gets out, and it is stated in
`docs/PARITY.md` rather than glossed. iOS reads the log file out of the app
container; Android would need `run-as` for that, which needs a debuggable
build, and a debug build does not verify the thing this job exists for — R8,
the bundled JavaScript and the packaged `.so` set are exactly what differs in
release. So the app reports its own verdict through `console.log`, which Hermes
routes to the `ReactNativeJS` logcat tag. A library that misreported its own
outcome would be believed there and caught on iOS; a run ID required in the
verdict line is what stops a stale logcat buffer signing off a run that never
happened.

Still not claimed: arm64 hardware, physical devices, and OS versions other than
API 34 — minimum-OS is `test-android-instrumented`'s claim, which runs down to
API 24.
