---
'react-native-nitro-logger': patch
---

Fix release builds on Android, which failed for every consumer.

The package declared no `codegenConfig`, and React Native's Gradle plugin runs
codegen for a library module regardless — with its scan root defaulting to the
package directory. From there it reached React Native's own `Native*.js` files,
treated them as this library's specs, and compiled about ninety
`com.facebook.fbreact.specs.*` and `com.facebook.react.viewmanagers.*` classes
into the artifact.

A consumer then had those classes twice, once from here and once from
`react-android`. Debug builds tolerate that; release builds fail:

    Type com.facebook.fbreact.specs.NativeAccessibilityInfoSpec is defined
    multiple times

Codegen is now scoped to this package's own `src`, and the artifact contains
this library's classes and nothing else. No API change, and nothing to do on
upgrade beyond a clean build.
