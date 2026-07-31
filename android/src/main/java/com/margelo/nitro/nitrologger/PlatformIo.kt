package com.margelo.nitro.nitrologger

import java.io.File
import java.io.FileDescriptor

/**
 * The handful of operations the writer needs that `java.io.File` cannot answer.
 *
 * Four of them are load-bearing rather than nice to have:
 *
 * - **Link count.** Writes to an unlinked file succeed forever and land
 *   nowhere. `File.exists()` cannot see it — the name may have been recreated
 *   by something else while this descriptor still points at the orphan — so
 *   without `fstat` an externally deleted log means silent loss for the rest of
 *   the process's life.
 * - **Directory sync.** `delete()` returning true only means the change is in
 *   the directory's in-memory state. Until the directory itself is synced a
 *   crash can bring every one of those names back, and a compliance purge
 *   exists precisely to promise they are gone.
 * - **Tri-state lookup.** `File.exists()` returns false for "not there" and for
 *   "could not tell" alike. A purge that treats the second as the first claims
 *   `durable = true` over artifacts that are still on disk.
 * - **Symlink detection.** `FileOutputStream` has no `O_NOFOLLOW`, so the check
 *   has to be a separate `lstat`.
 *
 * They live behind an interface so [LogFileWriter] imports nothing from
 * `android.*` and can be tested on a plain JVM, the same reason the iOS writer
 * has no Nitro imports.
 *
 * **`java.nio.file` is API 26 and this library supports 24.** Every use of it
 * is confined to [Jvm], which runs only under unit tests; [AndroidPlatformIo]
 * implements all four with `Os` syscalls and never delegates here for them. An
 * unresolvable class raises `NoClassDefFoundError`, which is an `Error` and
 * passes straight through `catch (Exception)` — so the isolation is what makes
 * this safe, not the catch blocks.
 */
interface PlatformIo {
  /**
   * What a no-follow lookup could establish about a path.
   *
   * [UNKNOWN] is the reason this is not a `Boolean`: a purge may only count an
   * artifact as gone when the platform actually said it was.
   */
  enum class Presence { PRESENT, ABSENT, UNKNOWN }

  /**
   * Hard links to the file behind this descriptor, or -1 when unknowable.
   *
   * -1 is not zero: a caller must treat it as "no evidence of a problem"
   * rather than as a deletion, or every write on a platform without `fstat`
   * would look like it had lost its file.
   */
  fun linkCount(descriptor: FileDescriptor): Int

  /** Commits a directory's own metadata — the removals — to storage. */
  fun syncDirectory(directory: File): Boolean

  /**
   * Whether [file] exists, without following a final symlink.
   *
   * Returns [Presence.UNKNOWN] for any failure that is not a plain "no such
   * file": a permissions problem, an I/O error, a volume that went away. The
   * purge reports those as failures rather than as successful deletions.
   */
  fun lookup(file: File): Presence

  /**
   * Whether the final component of [file] is a symbolic link.
   *
   * Returns true when it cannot be established. Refusing costs a log file;
   * guessing wrong writes one wherever the link points — a path the caller
   * never named and the purge would never clean.
   */
  fun isSymbolicLink(file: File): Boolean

  /**
   * Restricts an artifact to its owner: 0700 for directories, 0600 for files.
   *
   * Returns false if any part did not take, which the writer records as a
   * `protection` degradation rather than a failure. Android's app-private
   * storage is already inaccessible to other apps; these modes are the second
   * layer, and losing them is worth reporting but not worth refusing to log
   * over.
   */
  fun restrictToOwner(file: File, isDirectory: Boolean): Boolean

  /**
   * Creation time in epoch millis, or null when the platform cannot say.
   *
   * Only ever used to *seed* the age sidecar for a file that has none — the
   * sidecar is authoritative from then on. See `LogFileWriter.creationTimeOf`
   * for why the filesystem's answer cannot be trusted directly.
   */
  fun creationTimeMillis(file: File): Long?

  /**
   * Renames [from] onto [to], **replacing [to] atomically** if it exists.
   *
   * `File.renameTo` is not this. Its contract explicitly declines to say
   * whether an existing destination is replaced, or whether the operation is
   * atomic, or whether it works at all — behaviour it leaves to the platform.
   * The support-bundle publish needs all three: a reader of the bundle path
   * must see either the old bundle or the new one and never neither.
   *
   * The other half of the contract matters just as much: **a failure must leave
   * [to] untouched.** That is what lets a collect that cannot publish leave the
   * previous bundle in place, instead of deleting it first and then discovering
   * it has nothing to put there.
   *
   * Returns false if the rename did not happen, in which case both files are
   * where they were.
   */
  fun renameReplacing(from: File, to: File): Boolean

  /**
   * The unit-test implementation. **Not for Android**: it is the only place in
   * this package that touches `java.nio.file`, which does not exist below API
   * 26.
   */
  object Jvm : PlatformIo {
    override fun linkCount(descriptor: FileDescriptor): Int = -1

    override fun syncDirectory(directory: File): Boolean = directory.isDirectory

    override fun lookup(file: File): Presence = Nio.lookup(file)

    override fun isSymbolicLink(file: File): Boolean = Nio.isSymbolicLink(file)

    override fun restrictToOwner(file: File, isDirectory: Boolean): Boolean {
      // `false` as the second argument on the deny calls means "everyone",
      // which is the point: strip group and other first, then grant the owner
      // back. Doing it the other way round leaves a window where the file is
      // readable by anyone.
      var ok = file.setReadable(false, false)
      ok = file.setWritable(false, false) && ok
      ok = file.setExecutable(false, false) && ok
      ok = file.setReadable(true, true) && ok
      ok = file.setWritable(true, true) && ok
      if (isDirectory) ok = file.setExecutable(true, true) && ok
      return ok
    }

    override fun creationTimeMillis(file: File): Long? = Nio.creationTimeMillis(file)

    override fun renameReplacing(from: File, to: File): Boolean = Nio.renameReplacing(from, to)

    /**
     * Every `java.nio.file` reference in the package, in one object that
     * nothing on Android ever calls.
     *
     * Held separately from [Jvm] rather than inlined because
     * [AndroidPlatformIo] *does* resolve [Jvm] — for its `restrictToOwner`
     * fallback, which uses only `java.io` — and resolving it must not drag
     * `java.nio.file` into an Android class load.
     */
    private object Nio {
      fun lookup(file: File): Presence = try {
        val path = file.toPath()
        val noFollow = arrayOf(java.nio.file.LinkOption.NOFOLLOW_LINKS)
        when {
          java.nio.file.Files.exists(path, *noFollow) -> Presence.PRESENT
          java.nio.file.Files.notExists(path, *noFollow) -> Presence.ABSENT
          else -> Presence.UNKNOWN
        }
      } catch (_: Throwable) {
        Presence.UNKNOWN
      }

      fun isSymbolicLink(file: File): Boolean = try {
        java.nio.file.Files.isSymbolicLink(file.toPath())
      } catch (_: Throwable) {
        true
      }

      /**
       * `Files.move` with `ATOMIC_MOVE`, which on a POSIX filesystem is one
       * `rename(2)` — the same syscall [AndroidPlatformIo] makes directly.
       *
       * `ATOMIC_MOVE` rather than `REPLACE_EXISTING`, even though replacing is
       * what this is for. `Files.move` documents that when `ATOMIC_MOVE` is
       * given every other option is ignored, so the two cannot be combined —
       * and of the two it is `ATOMIC_MOVE` that actually delivers the contract
       * on [PlatformIo.renameReplacing]. `REPLACE_EXISTING` alone permits a
       * non-atomic copy-and-delete, which is the very shape this seam exists to
       * rule out; the replacement comes free, because that is what `rename(2)`
       * does with an existing destination.
       *
       * A filesystem that cannot promise atomicity throws
       * `AtomicMoveNotSupportedException` and this returns false. Failing
       * closed is the point: this implementation is what the unit tests measure
       * the contract against, so it must not quietly satisfy them with weaker
       * semantics than the device gets.
       *
       * `Exception`, not `Throwable`, unlike its neighbours here. Those return
       * a "cannot tell" value where swallowing is the whole point; this one
       * reports a *decision*, and an `Error` — a linkage failure, an OOM — is
       * not a rename that declined. It propagates.
       */
      fun renameReplacing(from: File, to: File): Boolean = try {
        java.nio.file.Files.move(
          from.toPath(),
          to.toPath(),
          java.nio.file.StandardCopyOption.ATOMIC_MOVE
        )
        true
      } catch (_: Exception) {
        false
      }

      fun creationTimeMillis(file: File): Long? = try {
        val attributes = java.nio.file.Files.readAttributes(
          file.toPath(),
          java.nio.file.attribute.BasicFileAttributes::class.java
        )
        attributes.creationTime().toMillis().takeIf { it > 0 }
      } catch (_: Throwable) {
        null
      }
    }
  }
}
