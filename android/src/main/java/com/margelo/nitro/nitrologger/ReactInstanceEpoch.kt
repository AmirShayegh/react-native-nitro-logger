package com.margelo.nitro.nitrologger

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Which React instance is current, and which are dead.
 *
 * A writer belongs to the JavaScript that opened it. When that JavaScript's
 * runtime is destroyed — a Metro reload, a `ReactHost.reload()`, an instance
 * teardown of any kind — nothing on the JavaScript side runs again, so nothing
 * closes the writer. On Android there is no backstop either: the Kotlin
 * `HybridObject` sits in a JNI strong-reference cycle broken only by an explicit
 * `dispose()`, so `finalize()` never runs and the descriptor and registry slot
 * are held by a runtime that no longer exists. The next runtime then cannot open
 * its own log file, because the dead one is still holding it with a different
 * rotation configuration — which is the whole of C13, and what
 * `C13ReloadLeakTest` reproduces.
 *
 * A *token* stands for one instance's lifetime. Handles acquired while it is
 * current are recorded against it, and when it ends they are released — the
 * claim being the unit of release, not the writer: a writer shared with a
 * still-live owner survives at a lower refcount rather than being closed under
 * it.
 *
 * **No `android.*` imports here, deliberately.** The signal this reacts to is
 * `NativeModule.invalidate()`, which is a React Native concept and needs a real
 * runtime — but the epoch arithmetic is where the ordering rules live, and those
 * are what a JVM test can check in milliseconds. `NitroLoggerLifecycle` is the
 * thin part that touches React Native, and it holds no logic worth testing.
 */
object ReactInstanceEpoch {

  private val lock = ReentrantLock()

  /**
   * Never reused, and never zero. A recycled token would let a *new* instance
   * inherit a dead one's claims, which is the opposite of the point.
   */
  private var nextToken = 1L
  private var current: Long? = null
  private val live = HashSet<Long>()

  /**
   * Where a dead instance's claims go.
   *
   * A seam rather than a direct call so the ordering rule below can be tested
   * without a registry at all: the fake asserts, from inside this call, that the
   * token is already dead.
   */
  internal var releaseOwner: (Long) -> Unit = { owner ->
    // Zero deadline. Whoever is tearing the instance down is not waiting on a
    // wedged disk, and on the reload path the JavaScript that would have cared
    // about durability is already gone.
    LogWriterRegistry.shared.releaseOwner(owner, 0.0)
  }

  /** Mints a token for a starting instance and makes it current. */
  fun begin(): Long = lock.withLock {
    val token = nextToken
    nextToken += 1
    live.add(token)
    current = token
    token
  }

  /**
   * Ends an instance: its claims are released and its token is dead for good.
   *
   * **Dead first, then swept, and the order is the synchronisation.** An
   * acquisition racing this either lands before the token is marked — in which
   * case its claim is registered and the sweep below takes it — or reads a dead
   * token and is refused. There is no third outcome, because the registry checks
   * liveness inside the same lock it registers the claim under. Marking dead
   * *after* sweeping would leave exactly that third outcome: a claim registered
   * against a token nothing will ever sweep again.
   *
   * Idempotent. A second call finds the token already gone and does nothing —
   * `invalidate()` is not documented to run exactly once.
   */
  fun end(token: Long) {
    val wasLive = lock.withLock {
      val removed = live.remove(token)
      // Only if it is still the current one. An older instance ending after a
      // newer one has already started must not clear the newcomer's token.
      if (current == token) current = null
      removed
    }
    if (!wasLive) return
    releaseOwner(token)
  }

  /**
   * Whether this token's instance is still running.
   *
   * Read by the registry, under the registry's own lock, on the acquisition
   * path — see [end] for why that placement is what makes the race safe.
   */
  fun isLive(token: Long): Boolean = lock.withLock { token in live }

  /**
   * The current instance's token, or null when there is no instance to speak of.
   *
   * Null is an ordinary answer, not a failure: a JVM test has no React instance,
   * and neither does a host where `NitroLoggerLifecycle` was never created. A
   * handle acquired with a null owner is recorded against nobody and behaves
   * exactly as it did before any of this existed — the fail-open direction,
   * chosen because a logger that stops working in an unfamiliar host is worse
   * than one that leaks a writer there.
   */
  fun currentOrNull(): Long? = lock.withLock { current }

  /** Test seam: forgets every token, so one test's epochs cannot outlive it. */
  internal fun resetForTesting() {
    lock.withLock {
      live.clear()
      current = null
      nextToken = 1L
    }
  }
}
