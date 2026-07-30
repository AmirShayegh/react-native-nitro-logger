package com.margelo.nitro.nitrologger

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The ordering rules a reload depends on, checked where they can be checked.
 *
 * `NitroLoggerLifecycle` is the part that touches React Native, and it holds no
 * logic: `initialize` begins an epoch, `invalidate` ends one. Everything that
 * decides what a destroyed instance's writers do is here, in plain Kotlin, and
 * so is testable without a device — which matters because the device test costs
 * a release build and an emulator, and because "a claim registered against a
 * token nothing will ever sweep" is a state no device test can produce on
 * demand.
 */
class ReactInstanceEpochTest {

  private val swept = mutableListOf<Long>()
  private lateinit var original: (Long) -> Unit

  @Before
  fun captureTheSeam() {
    original = ReactInstanceEpoch.releaseOwner
    ReactInstanceEpoch.resetForTesting()
    swept.clear()
  }

  @After
  fun restoreTheSeam() {
    ReactInstanceEpoch.releaseOwner = original
    ReactInstanceEpoch.resetForTesting()
  }

  @Test
  fun `an instance is current while it runs and nobody after it ends`() {
    assertNull("no instance has started", ReactInstanceEpoch.currentOrNull())

    val token = ReactInstanceEpoch.begin()

    assertEquals(token, ReactInstanceEpoch.currentOrNull())
    assertTrue(ReactInstanceEpoch.isLive(token))

    ReactInstanceEpoch.releaseOwner = { swept.add(it) }
    ReactInstanceEpoch.end(token)

    assertNull(ReactInstanceEpoch.currentOrNull())
    assertFalse(ReactInstanceEpoch.isLive(token))
  }

  /**
   * The rule the whole race rests on.
   *
   * The registry checks liveness inside the lock it registers a claim under. If
   * the token were marked dead *after* the sweep, an acquisition landing between
   * the two would register a claim against an owner nothing will ever sweep
   * again — a leaked writer with no path back to it, which is C13 with extra
   * steps. So the sweep is required to observe a token that is already dead.
   */
  @Test
  fun `the token is dead before anything is swept`() {
    val token = ReactInstanceEpoch.begin()
    var liveDuringSweep: Boolean? = null
    ReactInstanceEpoch.releaseOwner = { owner ->
      liveDuringSweep = ReactInstanceEpoch.isLive(owner)
      swept.add(owner)
    }

    ReactInstanceEpoch.end(token)

    assertEquals(listOf(token), swept)
    assertEquals("the sweep must run against a token that is already dead", false, liveDuringSweep)
  }

  @Test
  fun `ending twice sweeps once`() {
    val token = ReactInstanceEpoch.begin()
    ReactInstanceEpoch.releaseOwner = { swept.add(it) }

    ReactInstanceEpoch.end(token)
    ReactInstanceEpoch.end(token)

    // `invalidate()` is not documented to run exactly once, and a second sweep
    // of the same owner would be a second close of handles that may by then
    // belong to nobody.
    assertEquals(listOf(token), swept)
  }

  @Test
  fun `a token is never reused`() {
    val first = ReactInstanceEpoch.begin()
    ReactInstanceEpoch.releaseOwner = { swept.add(it) }
    ReactInstanceEpoch.end(first)
    val second = ReactInstanceEpoch.begin()

    // A recycled token would let a new instance inherit a dead one's claims,
    // and be swept by a teardown that has already happened.
    assertNotEquals(first, second)
    assertFalse(ReactInstanceEpoch.isLive(first))
    assertTrue(ReactInstanceEpoch.isLive(second))
  }

  /**
   * React Native destroys the old instance before creating the new one, but
   * nothing in this file may depend on that. An `end` arriving late must not
   * take the current token with it.
   */
  @Test
  fun `an older instance ending does not unseat the current one`() {
    val first = ReactInstanceEpoch.begin()
    val second = ReactInstanceEpoch.begin()
    ReactInstanceEpoch.releaseOwner = { swept.add(it) }

    ReactInstanceEpoch.end(first)

    assertEquals(second, ReactInstanceEpoch.currentOrNull())
    assertTrue(ReactInstanceEpoch.isLive(second))
    assertEquals(listOf(first), swept)
  }
}
