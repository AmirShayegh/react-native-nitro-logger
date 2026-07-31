package com.margelo.nitro.nitrologger

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

/**
 * The open path's failure mapping.
 *
 * This exists as its own object, rather than as a private method on
 * [HybridFileSink], because that class extends a generated Nitro spec that
 * needs the JNI layer — no JVM test can execute a line of it. The rule about
 * which throwables get normalized and which pass through is worth more than
 * the convenience of keeping it next to its one caller.
 *
 * ## What these tests do NOT prove
 *
 * That [HybridFileSink] actually calls this. Nothing off-device can prove that;
 * the `min-rn-android` smoke job is the only thing that runs the adapter at
 * all, and it does not provoke an open failure. What is pinned here is that
 * the mapping is right *when reached*.
 *
 * Nor do they compare the strings against iOS — a Gradle run cannot see a
 * Swift file. `__tests__/openFailureParity.test.js` does that, from Jest, which
 * can read both.
 */
class FileSinkMessagesTest {

  /**
   * Every kind gets its own message.
   *
   * The mapping is a `when` used as an expression, so a kind added without a
   * branch fails the build rather than this test — which is the better place
   * for it to fail. What a compiler cannot catch is a branch added by copying
   * its neighbour and left pointing at the neighbour's message, and that is
   * what the distinctness assertion is for.
   */
  @Test
  fun `each kind maps to its own non-empty message`() {
    val seen = mutableMapOf<String, LogWriterException.Kind>()
    for (kind in LogWriterException.Kind.entries) {
      val message = FileSinkMessages.openFailure(LogWriterException(kind, "raw")).message
      assertTrue("$kind has no message", !message.isNullOrEmpty())
      val clash = seen.put(message!!, kind)
      assertEquals("$kind and $clash send the same message", null, clash)
    }
    assertEquals(LogWriterException.Kind.entries.size, seen.size)
  }

  @Test
  fun `the kind survives the mapping`() {
    for (kind in LogWriterException.Kind.entries) {
      assertEquals(kind, FileSinkMessages.openFailure(LogWriterException(kind, "raw")).kind)
    }
  }

  /**
   * The payload is dropped, and that is the point of the mapping.
   *
   * `acquire` touches the filesystem, and a filesystem exception's message is
   * a path. A path carries a username on every platform this ships to, and
   * this string crosses into JavaScript and from there into whatever the app
   * logs — which is the one place `purge()` cannot reach.
   */
  @Test
  fun `a filesystem failure does not carry its path across the bridge`() {
    val leaky = IOException("/Users/aparticularperson/Library/Logs/app.log: permission denied")
    val mapped = FileSinkMessages.openFailure(leaky)

    assertEquals(FileSinkMessages.OPEN_FAILED, mapped.message)
    assertFalse(
      "the original text crossed the bridge",
      mapped.message!!.contains("aparticularperson")
    )
    assertEquals(LogWriterException.Kind.OPEN_FAILED, mapped.kind)
  }

  /** A `LogWriterException`'s own text is replaced too, not just a foreign one. */
  @Test
  fun `a writer failure's own text is replaced rather than forwarded`() {
    val leaky = LogWriterException(
      LogWriterException.Kind.SYMLINK_ESCAPE,
      "/Users/aparticularperson/Library/Logs/app.log is a symbolic link"
    )
    val mapped = FileSinkMessages.openFailure(leaky)

    assertEquals(FileSinkMessages.SYMLINK_ESCAPE, mapped.message)
    assertNotEquals(leaky.message, mapped.message)
  }

  /**
   * An `Error` is not an open failure and must not be dressed up as one.
   *
   * A linkage failure or an `OutOfMemoryError` reported as "could not open the
   * log file" sends whoever reads it to look at the filesystem for a problem
   * that is in the VM. It comes back out as the same object, not a copy: a
   * wrapped `Error` loses the stack that says where the VM actually broke.
   */
  @Test
  fun `an Error passes through unmapped`() {
    val fatal = NoClassDefFoundError("com/example/Absent")
    try {
      FileSinkMessages.rethrowingOpenFailure(fatal)
      fail("the Error was swallowed")
    } catch (thrown: Throwable) {
      assertSame("the Error was replaced rather than rethrown", fatal, thrown)
    }
  }

  /**
   * An interrupt survives the mapping that discards the exception carrying it.
   *
   * The flag is the only thing left saying the thread was asked to stop, once
   * the `InterruptedException` has been thrown away. Swallowing it is how a
   * thread stops being cancellable.
   */
  @Test
  fun `an interrupt is re-flagged before its exception is discarded`() {
    // Cleared first: JUnit reuses threads, so a flag left on by another test
    // would make this pass without the production code doing anything.
    Thread.interrupted()
    try {
      FileSinkMessages.rethrowingOpenFailure(InterruptedException("waiting on the close"))
      fail("nothing was thrown")
    } catch (mapped: LogWriterException) {
      assertEquals(FileSinkMessages.OPEN_FAILED, mapped.message)
    } finally {
      // Read *and* cleared, so this test leaves the thread as it found it.
      assertTrue("the interrupt was swallowed", Thread.interrupted())
    }
  }

  /** An ordinary exception still becomes an exception, not a pass. */
  @Test
  fun `a plain exception is mapped rather than swallowed`() {
    try {
      FileSinkMessages.rethrowingOpenFailure(IllegalStateException("something"))
      fail("nothing was thrown")
    } catch (mapped: LogWriterException) {
      assertEquals(FileSinkMessages.OPEN_FAILED, mapped.message)
    }
  }
}
