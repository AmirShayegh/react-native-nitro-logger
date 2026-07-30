---
'react-native-nitro-logger': minor
---

One process at a time: a file sink now takes an exclusive lock on its log file.

Two processes appending to one log file interleave mid-record and run two
rotation schedules over the same names — the collision the writer registry
prevents inside one process, arriving from outside it, where a registry cannot
see it. An app extension, a share sheet, a background service pointed at the
same path could all do it, and until now the log just quietly came apart.

Opening a sink takes a non-blocking exclusive lock on a `<logfile>.lock` file
next to the log — `flock` on iOS, `FileChannel.tryLock` on Android. An open that
finds another process holding it fails with "another process is writing this log
file" instead of appending alongside it. This does not make cross-process
*writing* work; it makes the second writer fail loudly rather than corrupt the
first one's file.

The lock is on a file of its own because rotation renames the active file and a
lock follows the inode — held on the log itself the exclusion would ride the
rename into an archive and leave the live file unguarded. It holds no log bytes
and is never deleted, including by `purge()`: unlinking a locked name lets the
next process lock a fresh file and write alongside the first, so removing it
would defeat the exclusion rather than serve it. `PurgeOutcome.durable` keeps
exactly the meaning it had.

A filesystem that cannot lock is a degradation, not a failure. The new
`exclusivity` bit (`1 << 5`) goes up in the mask `FileDestination.degradation()`
returns and logging continues — refusing to log because the storage will not
exclude would be a far worse answer than logging without the guarantee.
