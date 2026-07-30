package com.margelo.nitro.nitrologger

import android.system.Os
import android.system.OsConstants
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream

/**
 * The only suite in this library that needs a device.
 *
 * [AndroidPlatformIo] is every `android.system.Os` call the writer makes, and
 * until this file it was in no test at all. The Kotlin suite exercises
 * [PlatformIo.Jvm] instead — a *different implementation* of the same
 * interface, written for the desktop JVM — so a broken syscall path here would
 * have been invisible while the JVM job stayed green.
 *
 * **Not Robolectric.** Robolectric shadows `android.system.Os`, so a suite
 * written against it would swap zero coverage of this class for coverage of a
 * third implementation. That is the same defect with a green tick on it.
 *
 * ## What this suite does not prove
 *
 * The mode read-back in [AndroidPlatformIo.restrictToOwner] exists for
 * filesystems that accept a `chmod` and ignore it — the FUSE layer over shared
 * storage, a FAT-formatted volume. An emulator's app-private storage is ext4
 * and honours every `chmod`, so **nothing here can produce that filesystem**,
 * and deleting the read-back would not turn this suite red. What is proved is
 * the half that is reachable: the constants produce exactly `0700` and `0600`
 * through the real syscall, and the returned boolean agrees with what is
 * actually on disk in every case a device can be put into.
 *
 * The suite also says nothing about `noBackupFilesDir`, which is chosen in
 * `HybridFileSink.defaultLogDirectory` from a Nitro-supplied `Context` that no
 * library-module test has. That claim rests on reading the source and on the
 * manual example-app pass in PLAN.md, and is stated in `docs/PARITY.md` for
 * what it is.
 *
 * ## Why CI runs this at API 24 as well as 34
 *
 * [aPathThatIsNotThereCannotBeTightened] drives `restrictToOwner` down its
 * `java.io` fallback, which resolves [PlatformIo.Jvm]. `java.nio.file` is API
 * 26 and this library supports 24, so `Jvm` holds every reference to it in a
 * separate nested object for exactly this reason. If that split is ever
 * flattened the symptom is `NoClassDefFoundError` — an `Error`, so no
 * `catch (Exception)` in the file contains it — and API 24 is the only place
 * it can be seen.
 */
@RunWith(AndroidJUnit4::class)
class AndroidPlatformIoTest {

  private lateinit var directory: File

  @Before
  fun setUp() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    directory = File(context.noBackupFilesDir, "platform-io-${System.nanoTime()}")
    assertTrue(directory.mkdirs())
  }

  @After
  fun tearDown() {
    directory.deleteRecursively()
  }

  // MARK: - Modes

  /**
   * The precondition is asserted, not assumed.
   *
   * A `chmod 0777` that silently did not take would leave the directory at
   * whatever it was created with — plausibly already restrictive — and the
   * postcondition below would then pass without anything having been
   * tightened. That is the shape of vacuous pass this whole suite exists to
   * avoid, so the loosening is verified before the code under test runs.
   */
  @Test
  fun aPermissiveDirectoryIsTightenedToOwnerOnly() {
    val target = File(directory, "logs")
    assertTrue(target.mkdir())
    Os.chmod(target.absolutePath, 511 /* 0777 */)
    assertEquals("the directory was not actually loosened first",
                 511, maskedMode(target))

    assertTrue(AndroidPlatformIo.restrictToOwner(target, isDirectory = true))
    assertEquals(448 /* 0700 */, maskedMode(target))
  }

  @Test
  fun aPermissiveFileIsTightenedToOwnerOnly() {
    val target = File(directory, "app.log")
    FileOutputStream(target).use { it.write("x".toByteArray()) }
    Os.chmod(target.absolutePath, 438 /* 0666 */)
    assertEquals("the file was not actually loosened first",
                 438, maskedMode(target))

    assertTrue(AndroidPlatformIo.restrictToOwner(target, isDirectory = false))
    assertEquals(384 /* 0600 */, maskedMode(target))
  }

  /**
   * The two spellings must agree. The literals above are what the modes are
   * *supposed* to be; this is what the production constants say they are, and
   * a test that only read the constants back would agree with any value they
   * held.
   */
  @Test
  fun theModeConstantsAreTheModesThisSuiteAssertsOnDisk() {
    assertEquals(448, AndroidPlatformIo.DIRECTORY_MODE)
    assertEquals(384, AndroidPlatformIo.FILE_MODE)
    assertEquals(448, AndroidPlatformIo.wantedMode(isDirectory = true))
    assertEquals(384, AndroidPlatformIo.wantedMode(isDirectory = false))
  }

  /** A directory needs its execute bit; a file must not be handed one. */
  @Test
  fun onlyTheDirectoryGetsAnExecuteBit() {
    val file = File(directory, "app.log")
    FileOutputStream(file).use { it.write("x".toByteArray()) }
    AndroidPlatformIo.restrictToOwner(file, isDirectory = false)
    AndroidPlatformIo.restrictToOwner(directory, isDirectory = true)

    assertEquals(0, maskedMode(file) and OsConstants.S_IXUSR)
    assertTrue(maskedMode(directory) and OsConstants.S_IXUSR != 0)
  }

  /**
   * Nothing to tighten is not success. The `chmod` fails `ENOENT`, the
   * `java.io` fallback fails too, and the read-back cannot answer — all three
   * have to land on false, or the writer records protection it never got.
   */
  @Test
  fun aPathThatIsNotThereCannotBeTightened() {
    val missing = File(directory, "gone.log")
    assertFalse(AndroidPlatformIo.restrictToOwner(missing, isDirectory = false))
    assertFalse(AndroidPlatformIo.restrictToOwner(missing, isDirectory = true))
  }

  /**
   * `chmod` resolves the final symlink, so the read-back has to as well. If it
   * used `lstat` it would read the link's own mode — `0777` on Linux, always,
   * and unchangeable — and report failure for a target it had tightened
   * correctly.
   */
  @Test
  fun aSymlinkIsTightenedThroughToItsTarget() {
    val target = File(directory, "target.log")
    FileOutputStream(target).use { it.write("x".toByteArray()) }
    Os.chmod(target.absolutePath, 438 /* 0666 */)

    val link = File(directory, "link.log")
    Os.symlink(target.absolutePath, link.absolutePath)

    assertTrue(AndroidPlatformIo.restrictToOwner(link, isDirectory = false))
    assertEquals(384, maskedMode(target))
  }

  // MARK: - The rest of the syscalls

  /**
   * The three answers the writer distinguishes, on a real `fstat`.
   *
   * Zero is the one that matters: writes to an unlinked file keep succeeding
   * and land nowhere, and `File.exists()` cannot see it — the name may have
   * been recreated by something else while this descriptor still points at the
   * orphan. -1 is "cannot say", which must not be read as zero or the writer
   * reopens on every health check.
   *
   * A second hard link would be the obvious way to show the count moving in
   * the other direction, and it is not tested here: `link(2)` on app-private
   * storage is denied on this platform (`EACCES` under SELinux on API 36), so
   * the count above 1 is not a state a device can be put into.
   */
  @Test
  fun linkCountReportsWhatIsOnDiskAndMinusOneWhenItCannotSay() {
    val file = File(directory, "app.log")
    val stream = FileOutputStream(file)
    stream.use {
      assertEquals(1, AndroidPlatformIo.linkCount(it.fd))

      // The case the writer acts on: the name is gone but this descriptor
      // still writes, and the count is the only thing that says so.
      assertTrue(file.delete())
      assertEquals(0, AndroidPlatformIo.linkCount(it.fd))
    }

    // Closed. -1 is "cannot say", which the writer must not read as zero.
    assertEquals(-1, AndroidPlatformIo.linkCount(stream.fd))
  }

  @Test
  fun syncDirectorySucceedsForADirectoryAndFailsForOneThatIsNotThere() {
    assertTrue(AndroidPlatformIo.syncDirectory(directory))
    assertFalse(AndroidPlatformIo.syncDirectory(File(directory, "nope")))
  }

  /**
   * A dangling symlink is PRESENT: the name is occupied, and a purge that
   * treated it as absent would report an artifact gone that is still there.
   */
  @Test
  fun lookupSeesTheNameRatherThanWhatItPointsAt() {
    val file = File(directory, "app.log")
    FileOutputStream(file).use { it.write("x".toByteArray()) }
    assertEquals(PlatformIo.Presence.PRESENT, AndroidPlatformIo.lookup(file))

    assertEquals(PlatformIo.Presence.ABSENT,
                 AndroidPlatformIo.lookup(File(directory, "gone.log")))

    val dangling = File(directory, "dangling.log")
    Os.symlink(File(directory, "never-existed").absolutePath, dangling.absolutePath)
    assertEquals(PlatformIo.Presence.PRESENT, AndroidPlatformIo.lookup(dangling))
  }

  /**
   * A path under a directory this app cannot traverse cannot be resolved, and
   * unresolvable is UNKNOWN rather than ABSENT — the distinction the purge's
   * `durable` answer rests on.
   */
  @Test
  fun lookupReportsUnknownRatherThanAbsentWhenItCannotTell() {
    val locked = File(directory, "locked")
    assertTrue(locked.mkdir())
    val inside = File(locked, "app.log")
    FileOutputStream(inside).use { it.write("x".toByteArray()) }
    Os.chmod(locked.absolutePath, 0)

    try {
      assertEquals(PlatformIo.Presence.UNKNOWN, AndroidPlatformIo.lookup(inside))
    } finally {
      Os.chmod(locked.absolutePath, 448)
    }
  }

  @Test
  fun isSymbolicLinkAnswersForTheLeafAlone() {
    val target = File(directory, "target.log")
    FileOutputStream(target).use { it.write("x".toByteArray()) }
    val link = File(directory, "link.log")
    Os.symlink(target.absolutePath, link.absolutePath)

    assertTrue(AndroidPlatformIo.isSymbolicLink(link))
    assertFalse(AndroidPlatformIo.isSymbolicLink(target))
    // Not there is not a link. Failing closed here would refuse to create any
    // log file, since the leaf is absent every time one is opened.
    assertFalse(AndroidPlatformIo.isSymbolicLink(File(directory, "gone.log")))

    // A link *below* a symlinked directory is still not a symlinked leaf: the
    // registry canonicalizes the directory before the writer sees the path.
    val linkedDirectory = File(directory, "linked")
    Os.symlink(directory.absolutePath, linkedDirectory.absolutePath)
    assertFalse(AndroidPlatformIo.isSymbolicLink(File(linkedDirectory, "target.log")))
  }

  /**
   * Always null, and the sidecar is why. Several Android filesystems have no
   * birth time and hand back the mtime instead, which advances on every write
   * — trusting it would make the active file look freshly created at every
   * restart and postpone age-based rotation forever.
   */
  @Test
  fun creationTimeIsNeverAnsweredHere() {
    val file = File(directory, "app.log")
    FileOutputStream(file).use { it.write("x".toByteArray()) }
    assertNull(AndroidPlatformIo.creationTimeMillis(file))
  }

  // MARK: - Where the logs land when there is no Context

  /**
   * `HybridFileSink.defaultLogDirectory` falls back to `java.io.tmpdir` when
   * Nitro hands it no `Context`, and the 2026-07-29 review read that as a
   * fallback "outside app-private storage entirely". On a device it is not:
   * `ActivityThread` sets `java.io.tmpdir` to the app's own cache directory
   * during bind, so the fallback stays inside the app sandbox and inside a
   * directory Auto Backup already excludes.
   *
   * Pinned rather than argued, because it is a claim about the platform's
   * behaviour and the only thing that settles it is the platform. If some
   * future Android stops doing this, the fallback becomes a real privacy
   * question and this is where that shows up.
   */
  @Test
  fun theTmpdirFallbackStaysInsideTheAppSandbox() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val tmpdir = File(System.getProperty("java.io.tmpdir") ?: "/tmp").canonicalFile
    val dataDirectory = File(context.applicationInfo.dataDir).canonicalFile

    assertTrue("java.io.tmpdir is $tmpdir, outside $dataDirectory",
               tmpdir.path == dataDirectory.path ||
                 tmpdir.path.startsWith(dataDirectory.path + File.separator))
  }

  private fun maskedMode(file: File): Int =
    Os.stat(file.absolutePath).st_mode and AndroidPlatformIo.MODE_MASK
}
