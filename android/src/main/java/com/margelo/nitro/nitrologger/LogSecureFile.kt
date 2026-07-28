package com.margelo.nitro.nitrologger

import java.io.File

/**
 * Creating and locking down the files this package writes.
 *
 * The iOS twin has more to do here: a data-protection class and a backup
 * exclusion attribute, both applied per artifact. Android's equivalents are
 * structural rather than per file — the log directory lives under
 * `noBackupFilesDir`, which keeps it out of Auto Backup, and app-private
 * storage is already unreadable by other apps — so what is left for this file
 * is the second layer: owner-only modes on every artifact, and a refusal to
 * follow a symlink out of the directory the registry believes it owns.
 *
 * Every function reports whether it fully succeeded rather than throwing.
 * Failing to tighten a mode is worth recording as a `protection` degradation;
 * it is not worth refusing to log over.
 */
object LogSecureFile {
  /**
   * Creates the directory chain and restricts each level to its owner.
   *
   * Each level, not just the leaf: a 0700 directory inside a world-readable one
   * still hides its contents, but the intermediate `logs` name and the
   * timestamps on it are visible, and there is no reason to leak them.
   */
  fun createDirectory(directory: File, platform: PlatformIo): Boolean {
    var ok = true

    if (!directory.isDirectory) {
      // Walk down from the highest missing ancestor so each level can be
      // tightened as it appears. `mkdirs()` alone creates the whole chain with
      // default modes and gives no hook in between.
      val missing = generateSequence(directory) { it.parentFile }
        .takeWhile { !it.isDirectory }
        .toList()
        .asReversed()

      for (level in missing) {
        if (!level.mkdir() && !level.isDirectory) return false
        if (!platform.restrictToOwner(level, isDirectory = true)) ok = false
      }
    } else if (!platform.restrictToOwner(directory, isDirectory = true)) {
      ok = false
    }

    return ok && directory.isDirectory
  }

  /** Restricts one artifact to its owner. */
  fun secure(file: File, platform: PlatformIo): Boolean {
    if (!file.exists()) return true
    return platform.restrictToOwner(file, isDirectory = file.isDirectory)
  }

  /**
   * Whether the final component of a path is a symlink.
   *
   * Following one would write the app's log wherever the link points — a path
   * the caller never named and the purge would never clean — and would let two
   * different registry keys resolve to the same file. This is the `lstat` +
   * `S_IFLNK` check the iOS writer does, and it deliberately asks about the
   * leaf alone.
   *
   * **Only the leaf.** A symlinked *ancestor* is not a problem to refuse over:
   * the registry resolves the directory canonically before the writer ever
   * sees the path, precisely so that two names for one directory collapse to
   * one key. Comparing `canonicalFile` to `absoluteFile` would fold that
   * intended resolution into the check and refuse to open anything under a
   * symlinked parent at all — which on macOS is every `createTempFile`
   * directory, since `/var` is a link to `/private/var`.
   *
   * Delegated to [PlatformIo] rather than answered here: `Files.isSymbolicLink`
   * is API 26 and this library supports 24, so Android answers it with
   * `Os.lstat` instead.
   */
  fun isSymbolicLink(file: File, platform: PlatformIo): Boolean =
    platform.isSymbolicLink(file)
}
