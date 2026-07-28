package com.margelo.nitro.nitrologger

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The bridge's entry count, which arrives as a [Double].
 *
 * Each case here is one a bare `toLong()` gets wrong *silently*, which is the
 * whole reason the guard exists — the conversion saturates and truncates
 * instead of failing, so the writer downstream sees a plausible number and has
 * no way to know it was invented. iOS refuses the same values through
 * `Int(exactly:)`; these assert Android does too.
 */
class BridgeNumberTest {
  @Test
  fun `ordinary counts convert`() {
    assertEquals(0L, BridgeNumber.exactLong(0.0))
    assertEquals(1L, BridgeNumber.exactLong(1.0))
    assertEquals(1_000L, BridgeNumber.exactLong(1_000.0))
  }

  @Test
  fun `NaN is refused rather than becoming zero`() {
    // `Double.NaN.toLong()` is 0. A zero count with an empty batch satisfies
    // the writer's empty/non-empty check, so without this guard a NaN count
    // is accepted outright.
    assertEquals(0L, Double.NaN.toLong())
    assertNull(BridgeNumber.exactLong(Double.NaN))
  }

  @Test
  fun `infinities are refused rather than saturating`() {
    assertEquals(Long.MAX_VALUE, Double.POSITIVE_INFINITY.toLong())
    assertEquals(Long.MIN_VALUE, Double.NEGATIVE_INFINITY.toLong())
    assertNull(BridgeNumber.exactLong(Double.POSITIVE_INFINITY))
    assertNull(BridgeNumber.exactLong(Double.NEGATIVE_INFINITY))
  }

  @Test
  fun `a fractional count is refused rather than truncated`() {
    // The dangerous one: 2.5 becomes 2 and is accepted, so the batch is
    // written and every loss number derived from it is quietly wrong.
    assertEquals(2L, 2.5.toLong())
    assertNull(BridgeNumber.exactLong(2.5))
    assertNull(BridgeNumber.exactLong(-0.5))
    assertNull(BridgeNumber.exactLong(0.9999999))
  }

  @Test
  fun `an integral value too large for Long is refused`() {
    // 1e19 has no fractional part, so an integral check alone admits it, and
    // `toLong()` then clamps it to Long.MAX_VALUE.
    assertEquals(Long.MAX_VALUE, 1e19.toLong())
    assertNull(BridgeNumber.exactLong(1e19))
    assertNull(BridgeNumber.exactLong(-1e19))
  }

  @Test
  fun `the Long boundary is asymmetric because the two constants are`() {
    // Long.MAX_VALUE is 2^63 - 1 and is NOT representable as a Double:
    // `toDouble()` rounds it UP to 2^63. So the double that looks like the
    // maximum is actually one past it, and converting it back saturates to a
    // different number — the exact silent substitution this guard prevents.
    val roundedUp = Long.MAX_VALUE.toDouble()
    assertEquals(9.223372036854776E18, roundedUp, 0.0)
    assertEquals(Long.MAX_VALUE, roundedUp.toLong()) // saturated, not equal
    assertNull(BridgeNumber.exactLong(roundedUp))

    // The largest double strictly below 2^63 does fit, and must convert. Up
    // here the gap between adjacent doubles is 1024, so it is 2^63 - 1024.
    val largestThatFits = Math.nextDown(roundedUp)
    assertEquals(9223372036854774784L, BridgeNumber.exactLong(largestThatFits))

    // Long.MIN_VALUE is -2^63, which IS exactly representable, so the lower
    // bound is inclusive and round-trips.
    val min = Long.MIN_VALUE.toDouble()
    assertEquals(Long.MIN_VALUE, BridgeNumber.exactLong(min))
  }

  @Test
  fun `negative counts survive conversion and are left to the writer`() {
    // Not this function's job to range-check: -1 is exactly representable, so
    // it converts, and LogFileWriter.append rejects it with FAILED. Asserted
    // so the division of labour is not accidentally moved.
    assertEquals(-1L, BridgeNumber.exactLong(-1.0))
  }
}
