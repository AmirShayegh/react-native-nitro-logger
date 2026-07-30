#!/usr/bin/env bash
#
# What the Android artifact is allowed to contain.
#
# This exists because of a defect that shipped: with no `codegenConfig` in
# package.json, React Native's Gradle plugin runs codegen for this library
# anyway — it is unconditional for a library module — and defaults its scan root
# to the *package* directory. From there it reaches `example/node_modules/
# react-native/Libraries`, decides React Native's own `Native*.js` files are
# this library's specs, and compiles ~90 `com.facebook.fbreact.specs.Native*Spec`
# classes into the artifact.
#
# A consumer then has those classes twice: once from us, once from
# `react-android`. A debug build tolerates it — dex-per-class never compares
# them — and a **release** build does not:
#
#   Type com.facebook.fbreact.specs.NativeAccessibilityInfoSpec is defined
#   multiple times
#
# So every app that depended on this package and built a release APK failed to
# build, through 0.1.3, while CI stayed green: nothing here ever built an
# Android app in release. `react-native build-android` defaults to debug, and
# that is what `build:android` runs.
#
# The fix is one `codegenConfig` block scoping the scan to this package's own
# `src`. This gate is the part that keeps it fixed, and it asserts the *effect*
# rather than the cause — that the artifact contains nothing but this library's
# own classes — because the same symptom arrives from any dependency or plugin
# that starts compiling somebody else's code into ours, not only from that one
# key going missing.
#
# What it does not establish: that a consumer's release build links. That needs
# a pristine consumer app, which is `check-min-rn-android.sh`'s job; this one
# runs in seconds and catches the class of defect at its source.
set -uo pipefail

cd "$(dirname "$0")/.."

AAR="android/build/outputs/aar/react-native-nitro-logger-release.aar"

# Fresh outputs only: an AAR left by an earlier build would answer every
# question below about a tree that is no longer here.
rm -rf android/build/outputs/aar

(cd example/android && ./gradlew :react-native-nitro-logger:assembleRelease --console=plain)
GRADLE_STATUS=$?

if [ $GRADLE_STATUS -ne 0 ]; then
  echo "FAIL: gradle exited $GRADLE_STATUS"
  exit $GRADLE_STATUS
fi

python3 - "$AAR" <<'PY'
import collections
import io
import pathlib
import sys
import zipfile

# The one package this library is entitled to ship. Everything under it is ours
# by construction: `namespace` in android/build.gradle, and the nitrogen output
# generated into the same tree.
OWN_PACKAGE = 'com/margelo/nitro/nitrologger'

# Not an exact count, deliberately, and this is the one loose number here: the
# Kotlin compiler emits synthetic classes for lambdas and `when` mappings, and
# how many varies with its version. What the floor has to catch is an artifact
# that is empty or gutted — a jar with four classes in it is not this library —
# and it does that without failing on a toolchain bump.
MINIMUM_CLASSES = 40

path = pathlib.Path(sys.argv[1])
if not path.is_file():
    print(f'FAIL: the build produced no artifact at {path}')
    sys.exit(1)

aar = zipfile.ZipFile(path)
if 'classes.jar' not in aar.namelist():
    print(f'FAIL: {path} contains no classes.jar')
    sys.exit(1)

jar = zipfile.ZipFile(io.BytesIO(aar.read('classes.jar')))
packages = collections.Counter()
for name in jar.namelist():
    if name.endswith('.class'):
        packages['/'.join(name.split('/')[:-1])] += 1

total = sum(packages.values())
print(f'  artifact   -> {path}')
print(f'  classes    -> {total}')
for package, count in sorted(packages.items()):
    print(f'    {count:4d}  {package.replace("/", ".")}')

problems = []
foreign = sorted(p for p in packages if not p.startswith(OWN_PACKAGE))
if foreign:
    problems.append(
        'the artifact carries classes this library does not own: '
        + ', '.join(p.replace('/', '.') for p in foreign)
        + ' — a consumer gets each of these twice, and its release build fails'
        ' on the duplicate'
    )
if total < MINIMUM_CLASSES:
    problems.append(f'{total} classes, below the floor of {MINIMUM_CLASSES}')

if problems:
    for problem in problems:
        print(f'FAIL: {problem}')
    sys.exit(1)

print('ok:   the Android artifact contains this library and nothing else')
PY
