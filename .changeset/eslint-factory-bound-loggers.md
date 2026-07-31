---
'react-native-nitro-logger': minor
---

ESLint: a logger bound from a factory is no longer silently exempt

`classifyReceiver` resolved a binding's initializer and returned whatever
that produced, `null` included. So a binding whose initializer the analysis
could not see through was classified as "not a logger", and all four rules
went quiet at every call on it.

The spelling this hits is the ordinary one:

```js
const Log = useLogger();
Log.info(`patient ${patient.mrn} admitted`);
```

Canonical name, real logger, PHI in a template literal, and not one
diagnostic — because a hook is a call the analysis cannot follow. An
unresolvable initializer now falls through to the name heuristic, which is
what `shared.js` already said it does: "a receiver that merely *might* be a
logger is `'ambiguous'`, not discarded."

The widening is to `'ambiguous'`, never `'logger'`. Provenance is the
difference: what comes out of an opaque factory may behave like the
singleton, but nothing establishes that it *is* the singleton, and
`no-derived-correlation` must not assume it.

A `null` from a *construction* still ends the classification. `new Widget()`
is a decision — the callee was examined and found not logger-shaped — where
`useLogger()` is only a shrug, and conflating them would have made the
`loggerClassNames` option stop narrowing anything.

**This reports code that lints clean today.** A codebase getting its logger
from a hook, a factory, a conditional or a property read will see new
diagnostics on lines that were never examined before. They are not new
violations; they are violations that were always there and never looked at.
Each is fixable the usual way — a literal message with the value in
metadata — and `loggerNames` narrows what counts as a logger name if a
binding is being matched that should not be.
