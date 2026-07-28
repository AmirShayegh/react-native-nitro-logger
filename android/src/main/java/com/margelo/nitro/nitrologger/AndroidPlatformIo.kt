package com.margelo.nitro.nitrologger

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

  override fun restrictToOwner(file: File, isDirectory: Boolean): Boolean = try {
    // chmod through the path rather than the java.io.File permission helpers:
    // those go through three separate syscalls with observable intermediate
    // states, and cannot express 0700 in one step.
    Os.chmod(file.absolutePath, if (isDirectory) 448 /* 0700 */ else 384 /* 0600 */)
    true
  } catch (_: Throwable) {
    PlatformIo.Jvm.restrictToOwner(file, isDirectory)
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
}
