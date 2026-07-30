---
'react-native-nitro-logger': minor
---

Rotation and retention no longer wait for the next record: `maintain()` and
`scheduleMaintenance()`.

Rotation runs from the write path and nowhere else — the writer rotates when a
record makes the file too big or too old *as it is being appended*, and sweeps
retention when it opens or rotates. A sink nobody is logging to therefore keeps
whatever it had when the last record landed: an age rotation that never fires,
an expired archive that is never deleted, a `maxTotalLogBytes` cap that goes on
being exceeded. An app that logs on error and then has a quiet week has a
retention policy that did not run that week.

`FileDestination.maintain(deadlineMs?)` runs both, on the writer's own queue so
it cannot interleave with a rotation a write is already performing, and returns
the degradation mask read once its bounded wait is over — a prune that has
started failing shows up in the answer to the call that tried it, rather than on
the next append that may never come. A sweep still running when the deadline
expires is not in that answer; it finishes on the queue regardless, and any
status read after it completes carries what it found. `flush()` is not a
substitute and never was: it drains what is buffered and moves no files.

`scheduleMaintenance({ destination, intervalMs, deadlineMs, appState })` is the
timer, and it lives in JavaScript. A native one would have to run on a queue the
app cannot see, wake a suspended process, and answer to a retention policy the
JS side owns; a JS interval instead freezes when the JS thread freezes, and the
policy stays with the caller. It pauses off the foreground and takes one
catch-up sweep on the way back in — an interval frozen for six hours has six
hours of expired archives waiting — and does *not* sweep at install, because
opening the sink has just run one and app launch is the worst moment to scan a
directory. `intervalMs` defaults to five minutes and is clamped up to
`MINIMUM_MAINTENANCE_INTERVAL_MS` (30 seconds).

New exports: `scheduleMaintenance`, `MINIMUM_MAINTENANCE_INTERVAL_MS`,
`ScheduleMaintenanceOptions`, `MaintainableDestination`. The spec gains
`maintain(deadlineMs): SinkStatus`, so `FileSinkLike` implementations gain one
method.

Stated limits: a released or fenced handle sweeps nothing and reports the mask
it already had — the files it would sweep belong to whichever handle holds the
writer now — and a destination that is disposed does the same without calling
the sink at all.
