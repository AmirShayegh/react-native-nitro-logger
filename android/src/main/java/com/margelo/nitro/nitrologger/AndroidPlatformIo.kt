package com.margelo.nitro.nitrologger

import android.os.Process
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileDescriptor

/**
 * [PlatformIo] against the real syscalls.
 *
 * Split out from the interface so that every `android.*` import in the writer's
 * dependency graph lives in this one file, and the writer itself stays
 * runnable — and testable — on a plain JVM.
 *
 * Every method here is answered with `Os`, which is API 21. Nothing delegates
 * to [PlatformIo.Jvm] except [restrictToOwner], whose fallback uses only
 * `java.io`: `java.nio.file` is API 26 and this library supports 24, and a
 * missing class there would raise `NoClassDefFoundError` rather than something
 * a `catch (Exception)` would contain.
 */
object AndroidPlatformIo : PlatformIo {
  /**
   * The modes every artifact this package writes must end up with.
   *
   * Hoisted out of the `chmod` call because Kotlin has no octal literal, so
   * these are decimal and a transposed digit is not something reading the call
   * site catches. Named here, they can be pinned by a test rather than
   * restated by one — a test that spelled `448` a second time would agree with
   * whatever this file said.
   *
   * `448` is `0700`, `384` is `0600`.
   */
  internal const val DIRECTORY_MODE = 448
  internal const val FILE_MODE = 384

  /**
   * The bits of `st_mode` a mode argument can set — `07777`, so the three
   * permission triples plus setuid/setgid/sticky.
   *
   * Masked rather than compared whole: the rest of `st_mode` is the file type,
   * which `chmod` neither sets nor could change.
   */
  internal const val MODE_MASK = 4095

  internal fun wantedMode(isDirectory: Boolean): Int =
    if (isDirectory) DIRECTORY_MODE else FILE_MODE

  override fun linkCount(descriptor: FileDescriptor): Int = try {
    if (!descriptor.valid()) -1 else Os.fstat(descriptor).st_nlink.toInt()
  } catch (_: Throwable) {
    // Unknowable, which is not the same as zero. Reporting zero here would
    // make the writer reopen its file on every health check.
    -1
  }

  override fun syncDirectory(directory: File): Boolean {
    var fd: FileDescriptor? = null
    return try {
      fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
      Os.fsync(fd)
      true
    } catch (_: Throwable) {
      false
    } finally {
      if (fd != null) {
        try {
          Os.close(fd)
        } catch (_: Throwable) {
          // Nothing left to do about it, and the sync result already stands.
        }
      }
    }
  }

  /**
   * `lstat`, with the errno preserved.
   *
   * Only `ENOENT` means the path is gone. Everything else — `EACCES` on a
   * directory whose mode changed underneath us, `EIO` on failing storage — is
   * [PlatformIo.Presence.UNKNOWN], and the purge reports it as a failure
   * instead of counting a file it never saw removed as deleted.
   */
  override fun lookup(file: File): PlatformIo.Presence = try {
    Os.lstat(file.absolutePath)
    PlatformIo.Presence.PRESENT
  } catch (e: ErrnoException) {
    if (e.errno == OsConstants.ENOENT) PlatformIo.Presence.ABSENT
    else PlatformIo.Presence.UNKNOWN
  } catch (_: Throwable) {
    PlatformIo.Presence.UNKNOWN
  }

  override fun isSymbolicLink(file: File): Boolean = try {
    OsConstants.S_ISLNK(Os.lstat(file.absolutePath).st_mode)
  } catch (e: ErrnoException) {
    // A path that is not there is not a symlink. Anything else is unresolvable,
    // and unresolvable has to fail closed.
    e.errno != OsConstants.ENOENT
  } catch (_: Throwable) {
    true
  }

  /**
   * Tightens the mode, then **reads it back** and answers on what is actually
   * on the file.
   *
   * A successful `chmod` is not evidence that the mode took. Android mounts
   * filesystems that quietly ignore it — the FUSE layer over shared storage
   * derives permissions from the mount and returns success for any `chmod`,
   * and a FAT-formatted volume has no mode bits to set — and every one of
   * those returns 0 while leaving the file exactly as readable as it was. The
   * only honest source for "is this file owner-only" is the file.
   *
   * `stat`, not `lstat`: `chmod` resolves the final symlink, so the inode this
   * verifies has to be the one `chmod` acted on. `lstat` would report the
   * link's own mode — `0777` on Linux, always — and fail every time. (The
   * writer refuses a symlinked leaf before it gets here; that is a separate
   * check with a separate reason, and this must not silently double as it.)
   *
   * The verdict covers the fallback too, which is the point of doing it after
   * both: `java.io`'s permission helpers cannot express `0700` in one step, so
   * whether they arrived somewhere acceptable is exactly the question, and
   * their own return values only report that the calls were made.
   *
   * False here is a `protection` degradation, not a failure — see [PlatformIo].
   */
  override fun restrictToOwner(file: File, isDirectory: Boolean): Boolean {
    val wanted = wantedMode(isDirectory)

    // chmod through the path rather than the java.io.File permission helpers:
    // those go through three separate syscalls with observable intermediate
    // states, and cannot express 0700 in one step.
    val attempted = try {
      Os.chmod(file.absolutePath, wanted)
      true
    } catch (_: Throwable) {
      PlatformIo.Jvm.restrictToOwner(file, isDirectory)
    }

    return try {
      attempted && (Os.stat(file.absolutePath).st_mode and MODE_MASK) == wanted
    } catch (_: Throwable) {
      // Cannot say, and cannot say has to read as "not tightened": the caller
      // records a degradation, and claiming protection this code never
      // confirmed is the one direction that matters.
      false
    }
  }

  /**
   * Always null on Android — the age sidecar is the mechanism here.
   *
   * `BasicFileAttributes.creationTime()` is API 26, and where it does exist it
   * is not reliably populated: several Android filesystems have no birth time
   * and return the mtime instead. An mtime advances on every write, so trusting
   * it would make the active file look freshly created at every restart and
   * postpone age-based rotation forever. Reporting nothing is what tells
   * `LogFileWriter.creationTimeOf` to seed the sidecar from the clock and treat
   * it as authoritative.
   */
  override fun creationTimeMillis(file: File): Long? = null

  /**
   * `Os.rename` — API 21, and the raw `rename(2)`, which is what the contract
   * on [PlatformIo.renameReplacing] describes: it replaces an existing
   * destination atomically, and on failure it does not touch it.
   *
   * `Files.move` would say the same thing but is API 26; `File.renameTo`
   * reaches the same syscall on Linux but promises none of it. There is no
   * delete-then-rename fallback here on purpose — one would reintroduce
   * exactly the window this call exists to close, and would run precisely when
   * the rename is failing, which is the worst moment to be holding no bundle.
   */
  override fun renameReplacing(from: File, to: File): Boolean = try {
    Os.rename(from.absolutePath, to.absolutePath)
    true
  } catch (_: ErrnoException) {
    false
  }

  /**
   * One notch below default, on whichever thread calls this.
   *
   * `THREAD_PRIORITY_LESS_FAVORABLE` is +1, and the sum is nice 1 — still in
   * the foreground cgroup. `THREAD_PRIORITY_BACKGROUND` (10) would be the
   * obvious choice and is the wrong one: at 10 and above Android moves the
   * thread into a background cgroup capped at a few percent of a core while
   * anything foreground runs, and a `flush` on the crash path blocks on this
   * thread with a deadline it has already promised the caller.
   *
   * Swallows failure. This is a scheduling hint; a sink that refused to log
   * because it could not lower its own priority would be worse than one that
   * logs at the wrong priority.
   */
  override fun deprioritizeCurrentThread() {
    try {
      Process.setThreadPriority(
        Process.THREAD_PRIORITY_DEFAULT + Process.THREAD_PRIORITY_LESS_FAVORABLE
      )
    } catch (_: RuntimeException) {
      // SecurityException on a locked-down runtime, IllegalArgumentException if
      // the constants ever stop summing to something legal.
    }
  }
}
