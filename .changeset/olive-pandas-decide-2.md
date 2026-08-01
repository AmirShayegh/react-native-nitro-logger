---
'react-native-nitro-logger': minor
---

New: `PlatformConsoleFormatter`, for sinks that already stamp the time

`NativeConsoleDestination` writes through `DefaultFormatter`, which renders
` INFO | 12:15:30.842 | ` in front of every line. Both native writers pass the
text through verbatim and stamp their own severity and timestamp on top, so
Console.app shows the same instant twice, a millisecond apart, and every
logcat line carries a priority it is also spelling out.

`PlatformConsoleFormatter` writes the rest of the layout and nothing else:

    [correlation] [subsystem] message {key=value}

**Opt-in, and staying that way.** This changes what a developer sees, which a
package upgrade should not do by itself:

```ts
import {
  createNativeConsoleDestination,
  PlatformConsoleFormatter,
} from 'react-native-nitro-logger';

createNativeConsoleDestination({ formatter: new PlatformConsoleFormatter() });
```

Those 23 characters are not only noise, and they are paid per line rather than
once per entry: every continuation line carries the same columns blanked out,
against four characters here. A thirty-frame stack trace spends 713 characters
on framing under the default layout and 120 under this one. os_log and logcat
both chunk the rendered entry by size — around 900 bytes and a budget shared
with the tag — so that is 593 bytes handed back to the content.

Structured fields — correlation, subsystem, metadata keys and values — are
escaped exactly as `DefaultFormatter` escapes them; that is one shared
implementation, not two. The continuation marker for multi-line messages is
weaker here and deliberately so: with no columns to blank, a message beginning
`  | ` renders a first line that reads like a continuation. What that can
impersonate is another line of your app's console output, never a record. The
durable copy is `FileDestination`'s and `JsonLinesFormatter` is what makes it
unforgeable; keep the default if you want the stronger guarantee in the console
as well.
