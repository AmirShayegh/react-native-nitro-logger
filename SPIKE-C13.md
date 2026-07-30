# Spike — C13: the Android sink's lifetime, and why the reload leak is deferred

Status: **deferred, whole.** Nothing in this spike was implemented. `finalize()`
stays where it is, with its documentation corrected. Written 2026-07-29 against
`react-native-nitro-modules@0.36.3`.

The 0.1.3 plan put a gate in front of this work: before any code, name the
authoritative owner of a writer's claim, the **observable termination signal**
that says the owner is gone, and the synchronization protocol between them —
and if the mechanisms cannot supply that signal, defer the whole item rather
than ship the half of it that looks like progress. This is the result of
running that gate. It failed at the second requirement.

## The defect, restated

`LogWriterRegistry` shares one `LogFileWriter` per canonical path and hands out
refcounted handles. `HybridFileSink.close()` releases one. A Metro reload tears
the JavaScript context down without running any JavaScript, so nothing calls
`close()` or `dispose()` — the writer survives the reload holding the registry
slot and the file descriptor, and the next `open` with a different rotation
config fails `CONFIG_CONFLICT` against a sink nothing can reach to close. On a
developer's machine that is an every-reload failure.

`finalize()` was written as the backstop. It is not one.

## Finding 1 — `finalize()` cannot run, and the reason is not the one in the review

The 2026-07-29 review said "neither C++ destructor calls `dispose()`". That is
true but is not what makes the object immortal: `JHybridObject::~JHybridObject`
*does* release its global reference to the Kotlin object
(`JHybridObject.cpp`, `_javaPart.reset()` inside a `ThreadScope`). Destroying
the C++ hybrid is not enough, because it is not the object holding the cycle.

The cycle is one level down, in `HybridObject.CxxPart`:

```
  Kotlin HybridObject.CxxPart
    → mHybridData (fbjni HybridData)
      → C++ JHybridObject::CxxPart
        → jni::global_ref<CxxPart::jhybridobject> _cxxJavaPart
          → back to the same Kotlin CxxPart
```

A JNI global reference is a GC root, so this three-hop cycle is rooted from
outside the Java heap and ART can never collect it. The Kotlin `CxxPart` also
holds `val javaPart: HybridObject` **strongly** — so `HybridFileSink` itself is
pinned for the life of the process. (`HybridObject.cxxPartCache` is a
`WeakReference`, which looks like it should help and does not: it is the edge
pointing the other way.)

The only thing that breaks it is `HybridData.resetNative()`, reached through
`CxxPart.destroy()`, reached through `HybridObject.dispose()` — the very call
the reload does not make.

So: `finalize()` on `HybridFileSink` is dead code today. Not "unlikely to run
promptly" — unreachable, for a structural reason, until Nitro changes.

The cycle is created the first time C++ asks for the Kotlin object's `CxxPart`,
which is when JavaScript constructs the hybrid. It is not created by
instantiating the Kotlin class on its own, which is why no library-module test
can reproduce this: reproducing it needs a live JS runtime.

## Finding 2 — there is a candidate termination signal, and it is not proven

React Native does destroy the `ReactContext` on a reload, and a package can
observe that (`ReactContext.addLifecycleEventListener`, and the instance
teardown path `ReactHost` drives in bridgeless mode). That is a real signal
with a real owner: `NitroLoggerPackage` holds the context, `LogWriterRegistry`
owns the claims, and the registry's existing lock is the protocol.

What is missing is the proof, and the plan named exactly what it has to be —
three phases, because "the old claim was released and a second writer was
rejected" conflates two states, and one assertion could accidentally encode
*permanent* rejection:

1. a competitor is rejected while the original writer is live;
2. the termination signal is observed and the claim released;
3. exactly one replacement is accepted, and any additional concurrent one is
   still rejected.

Phase 2 is the problem. Observing it requires a host that stands up a real
`ReactInstance`, constructs the hybrid from JavaScript (see Finding 1 — nothing
else creates the state under test), reloads, and inspects the registry
afterwards. The library module's instrumented suite has no `ReactInstance`; the
example app has one but no assertion harness. Building that harness is a larger
piece of work than the fix it would gate, and a harness that quietly fails to
reproduce the teardown would produce a green three-phase test that proves
nothing — which is the failure mode this whole review cycle exists to avoid.

## Finding 3 — the naive alternatives are worse than the leak

- **Expire the claim on a timer, or on the next `open`.** Two live writers for
  one path, appending through two descriptors with two rotation policies. The
  leak costs a developer a reload; this costs interleaved records and a purge
  that misses half its artifacts.
- **Reclaim when the holder looks like the same process and config.** Same
  hazard, with a heuristic in front of it. "Looks like" is not a termination
  signal.
- **Delete `finalize()` and call it done.** It removes a comment that promises
  something untrue and changes no behaviour, which is the shape of a fix that
  closes a ticket without closing a defect.

## What was done instead

- The `finalize()` KDoc no longer claims to be a backstop. It states that it
  cannot currently run, why, and what would change that.
- `docs/PARITY.md` carries the real lifecycle contract: on iOS `deinit` returns
  the descriptor and the registry slot with no cooperation from JavaScript; on
  Android there is no equivalent, so `close()`/`dispose()` is load-bearing and
  a development reload leaks until the process ends.

## What would reopen this

- Nitro breaking the `CxxPart` self-cycle, or exposing a teardown hook on
  `HybridObject`. Then `finalize()` becomes live and gets a test, or is
  replaced by the hook.
- An instrumented host for the example app that can reload a `ReactInstance`
  under test. Then the three-phase test above is writable and the
  registry-level fix is gated properly.

Neither is 0.1.3 work.
