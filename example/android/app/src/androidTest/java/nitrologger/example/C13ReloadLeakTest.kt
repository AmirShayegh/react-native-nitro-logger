package nitrologger.example

import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.margelo.nitro.nitrologger.AndroidPlatformIo
import com.margelo.nitro.nitrologger.LogRotationPolicy
import com.margelo.nitro.nitrologger.LogWriterException
import com.margelo.nitro.nitrologger.LogWriterRegistry
import com.margelo.nitro.nitrologger.ReactInstanceEpoch
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The observation `SPIKE-C13.md` could not make.
 *
 * C13 is the Metro-reload writer leak: a `ReactInstance` is destroyed, its
 * JavaScript dies without closing anything, and on Android nothing in the
 * teardown path reaches the writer it left open. `finalize()` cannot run — the
 * Kotlin `HybridObject` sits in a JNI strong-reference cycle broken only by an
 * explicit `dispose()` — so the descriptor and the registry slot are held by a
 * runtime that no longer exists.
 *
 * The spike's gate failed on "observable termination signal proven", and it
 * failed for want of a test host: the library's own instrumented APK has no
 * `ReactHost` and no bundle, and the leaked state only exists once JavaScript
 * has actually constructed the hybrid. So the harness lives here, in the
 * example app, where both are real.
 *
 * **This landed red, one commit before the fix, and that is the evidence it is
 * worth anything.** A harness that quietly fails to reproduce the bug it was
 * built for proves nothing by passing afterwards. With the fix absent it
 * reported:
 *
 *     timed out after 60000 ms waiting for the reloaded runtime's launch.
 *     nonces on disk: [ms7g0cti-1ghmp]
 *     live writers:   1
 *
 * and the app's own logcat named the mechanism — the reloaded runtime's
 * `OPEN_FAILED … this file is already open with a different configuration`.
 *
 * ### What each phase establishes
 *
 * 1. **Refused while live.** A rival acquire on the harness's path, with a
 *    configuration nobody can be holding, is refused. Without this, phase 3
 *    proves nothing: a refusal there could mean the registry refuses everything.
 * 2. **The runtime really dies.** `reload` destroys the instance and builds a
 *    new one, which remounts the harness. Observed through the harness's own
 *    output rather than asserted from the outside.
 * 3. **Exactly one replacement.** The new runtime reopens the same path with a
 *    *new* rotation configuration and its record reaches the disk. Before the
 *    fix the dead runtime's writer still holds that path with the old
 *    configuration, so the reopen is refused and no second nonce is ever
 *    written.
 *
 * ### What it does not establish
 *
 * The old architecture's teardown (this runs bridgeless on RN 0.85, and the
 * `invalidate()` contract the fix relies on is the same on both, which is an
 * argument and not a test); a process with more than one `ReactHost`;
 * `finalize()` running, which it still cannot; and iOS, where `deinit` already
 * covers this and the Swift suite pins it.
 */
@RunWith(AndroidJUnit4::class)
class C13ReloadLeakTest {

  private lateinit var logFile: File

  /**
   * A configuration no harness launch will ever pick, so a refusal is about the
   * path being held rather than about this test colliding with itself. The
   * harness uses multi-megabyte sizes; this is 64 KB.
   */
  private val rivalPolicy = LogRotationPolicy(
    maxFileSizeBytes = 64L * 1024,
    maxArchivedFilesCount = 1,
    maxFileAgeSeconds = null,
    compressArchives = false,
    maxArchiveAgeSeconds = null,
    maxTotalLogBytes = null
  )

  @Before
  fun clearStaleArtifacts() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val directory = File(context.noBackupFilesDir, "logs")
    logFile = File(directory, HARNESS_FILENAME)
    // A file left by an earlier run would answer every "did the record land"
    // question below with somebody else's records.
    directory.listFiles()?.forEach { if (it.name.startsWith(HARNESS_FILENAME)) it.delete() }
  }

  @Test
  fun aDestroyedRuntimeStopsHoldingTheWriterItOpened() {
    val scenario = ActivityScenario.launch(C13HarnessActivity::class.java)
    scenario.use {
      // ---- Phase 1: the writer is live, and rivals are refused ----------
      val first = awaitNonce(after = emptySet(), what = "the harness's first launch")
      assertRivalRefused("while the first runtime is live")

      // Reading this at all is an assertion: the epoch only has a current token
      // because `NitroLoggerLifecycle` was created and initialized, which
      // happens only under `needsEagerInit`. Nothing in JavaScript calls that
      // module, so lazily it would never exist and this would be null.
      val firstEpoch = ReactInstanceEpoch.currentOrNull()
      assertNotNull("no React instance registered itself; the module never ran", firstEpoch)
      assertEquals(
        "the harness's destination should be claimed by the runtime that opened it",
        1,
        LogWriterRegistry.shared.claimCountForOwnerForTesting(firstEpoch!!)
      )

      // ---- Phase 2: destroy the runtime that opened it -------------------
      val application = ApplicationProvider.getApplicationContext<MainApplication>()
      InstrumentationRegistry.getInstrumentation().runOnMainSync {
        application.reactHost.reload("C13 phase 2")
      }

      // The claims of the destroyed instance are gone. Waited for rather than
      // asserted outright: `invalidate()` runs on React Native's own teardown
      // thread, so "already" is not a thing this can assume.
      awaitClaimsReleased(firstEpoch)

      // ---- Phase 3: exactly one replacement ------------------------------
      // The new runtime opens the same path with a rotation configuration of
      // its own. Before the fix the dead runtime's writer still holds the path
      // with the old one, the open is refused, and this wait runs out.
      val second = awaitNonce(after = setOf(first), what = "the reloaded runtime's launch")
      assertNotEquals("the reload produced no new runtime", first, second)

      assertRivalRefused("after the reload")
      assertEquals(
        "the reload must leave one writer on this path, not two and not none",
        1,
        LogWriterRegistry.shared.liveWriterCountForTesting
      )

      val secondEpoch = ReactInstanceEpoch.currentOrNull()
      assertNotNull("the replacement instance registered nothing", secondEpoch)
      assertNotEquals("the epoch must be a new one, not the corpse of the old", firstEpoch, secondEpoch)
      assertEquals(
        "and the file is claimed by the runtime that is actually running",
        1,
        LogWriterRegistry.shared.claimCountForOwnerForTesting(secondEpoch!!)
      )
    }
  }

  /** Bounded, with the same state dump as every other wait here. */
  private fun awaitClaimsReleased(owner: Long) {
    val deadline = System.nanoTime() + AWAIT_NANOS
    while (System.nanoTime() < deadline) {
      if (LogWriterRegistry.shared.claimCountForOwnerForTesting(owner) == 0) return
      Thread.sleep(POLL_MS)
    }
    fail(
      "timed out after ${AWAIT_NANOS / 1_000_000} ms waiting for the destroyed" +
        " runtime's claims to be released.\n" +
        "  claims left:   ${LogWriterRegistry.shared.claimCountForOwnerForTesting(owner)}\n" +
        "  live writers:  ${LogWriterRegistry.shared.liveWriterCountForTesting}\n" +
        "  closing paths: ${LogWriterRegistry.shared.closingCountForTesting}"
    )
  }

  /**
   * Waits for a harness launch whose nonce is not one already seen.
   *
   * Reads the file rather than logcat: the question is whether the records
   * reached storage, and a line in logcat is not a line on disk.
   */
  private fun awaitNonce(after: Set<String>, what: String): String {
    val deadline = System.nanoTime() + AWAIT_NANOS
    var seen: Set<String> = emptySet()
    while (System.nanoTime() < deadline) {
      seen = noncesInFile()
      val fresh = seen - after
      if (fresh.isNotEmpty()) return fresh.first()
      Thread.sleep(POLL_MS)
    }
    fail(
      "timed out after ${AWAIT_NANOS / 1_000_000} ms waiting for $what.\n" +
        "  nonces on disk: $seen\n" +
        "  already seen:   $after\n" +
        "  live writers:   ${LogWriterRegistry.shared.liveWriterCountForTesting}\n" +
        "  closing paths:  ${LogWriterRegistry.shared.closingCountForTesting}\n" +
        "  log file:       ${logFile.absolutePath} (${logFile.length()} bytes)"
    )
    error("unreachable")
  }

  private fun noncesInFile(): Set<String> {
    if (!logFile.isFile) return emptySet()
    return NONCE.findAll(logFile.readText()).map { it.groupValues[1] }.toSet()
  }

  /**
   * A rival acquire on the harness's path must be refused for the configuration
   * it asks for — which is what proves a writer is holding that path.
   *
   * A handle handed back instead is both a failure and a leak, so it is closed
   * before the assertion fires.
   */
  private fun assertRivalRefused(when_: String) {
    val handle = try {
      LogWriterRegistry.shared.acquire(
        path = logFile.absolutePath,
        policy = rivalPolicy,
        lineFramed = true,
        platform = AndroidPlatformIo
      )
    } catch (expected: LogWriterException) {
      assertEquals(
        "refused $when_, but not for the reason that means a writer holds it",
        LogWriterException.Kind.CONFIG_CONFLICT,
        expected.kind
      )
      return
    }
    handle.close(0.0)
    fail("a rival acquire $when_ was granted; nothing is holding the path")
  }

  private companion object {
    /** Matches the harness's `launch=<nonce>` record. */
    val NONCE = Regex("""launch=([A-Za-z0-9]+-[A-Za-z0-9]+)""")

    /**
     * Generous on purpose: a release build's first mount includes bundle
     * evaluation, and the point of the wait is to distinguish "did not happen"
     * from "has not happened yet". A leak fails this by never happening at all.
     */
    const val AWAIT_NANOS = 60_000L * 1_000_000L
    const val POLL_MS = 250L
  }
}

/** Kept in step with `example/src/C13ReloadHarness.tsx`. */
private const val HARNESS_FILENAME = "c13-reload.log"
