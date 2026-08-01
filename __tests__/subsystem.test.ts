import { Logger } from '../src/Logger';
import { TestDestination } from './helpers/TestDestination';

function makeLogger() {
  const logger = new Logger();
  const dest = new TestDestination();
  logger.removeDestination('console');
  logger.addDestination(dest);
  return { logger, dest };
}

describe('subsystem level resolution', () => {
  test('exact match wins', () => {
    const { logger, dest } = makeLogger();
    logger.minimumLevel('error').subsystem('network', 'debug');
    logger.debug('hit', undefined, 'network');
    expect(dest.messages).toEqual(['hit']);
  });

  test('walks up the dot hierarchy: a.b.c → a.b → a', () => {
    const { logger, dest } = makeLogger();
    logger.minimumLevel('error').subsystem('network', 'info');
    logger.info('parent applies', undefined, 'network.api.rest');
    logger.debug('below parent level', undefined, 'network.api.rest');
    expect(dest.messages).toEqual(['parent applies']);
  });

  test('more specific child level beats the parent', () => {
    const { logger, dest } = makeLogger();
    logger.subsystem('network', 'error').subsystem('network.api', 'debug');
    logger.debug('child allows', undefined, 'network.api');
    logger.debug('parent blocks', undefined, 'network.socket');
    expect(dest.messages).toEqual(['child allows']);
  });

  test('no subsystem match falls back to the global minimum', () => {
    const { logger, dest } = makeLogger();
    logger.minimumLevel('warning');
    logger.info('blocked', undefined, 'unconfigured');
    logger.warning('passes', undefined, 'unconfigured');
    expect(dest.messages).toEqual(['passes']);
  });

  test('resetSubsystem restores parent/global fallback', () => {
    const { logger, dest } = makeLogger();
    logger.minimumLevel('error').subsystem('av', 'debug');
    logger.debug('while set', undefined, 'av');
    logger.resetSubsystem('av');
    logger.debug('after reset', undefined, 'av');
    expect(dest.messages).toEqual(['while set']);
  });
});

/**
 * Reconfiguring AFTER a subsystem has already been resolved once.
 *
 * Resolution is memoised per subsystem name, so every one of these asks the
 * question the memo can get wrong: the first call populates it, the config
 * change has to discard it, and the second call must reflect the new
 * configuration rather than the remembered answer.
 *
 * The suite did not previously ask this. Every test above configures first
 * and logs afterwards, which never populates a memo that a later change
 * could staleness — and a probe confirmed it: deleting the invalidation from
 * `subsystem()` and from `minimumLevel()` left all 1115 tests green. Only
 * `resetSubsystem` happened to be written log-then-reconfigure and caught it.
 *
 * Both directions are covered on purpose. A stale memo that keeps logging
 * after the config said stop is a privacy failure in a package whose thesis
 * is that the config is what stops it; a stale memo that keeps filtering
 * after the config said log loses the diagnostics someone just asked for.
 */
describe('level resolution after the configuration changes', () => {
  test('setting a subsystem level is seen by a name already resolved once', () => {
    const { logger, dest } = makeLogger();
    logger.minimumLevel('error');
    logger.info('before: filtered by the global minimum', undefined, 'media');

    logger.subsystem('media', 'info');
    logger.info('after: the new subsystem level applies', undefined, 'media');

    expect(dest.messages).toEqual(['after: the new subsystem level applies']);
  });

  test('tightening a subsystem level stops a name that was passing', () => {
    const { logger, dest } = makeLogger();
    logger.subsystem('media', 'debug');
    logger.debug('before: allowed', undefined, 'media');

    logger.subsystem('media', 'error');
    logger.debug('after: must be filtered', undefined, 'media');

    expect(dest.messages).toEqual(['before: allowed']);
  });

  test('setting a PARENT level is seen by a descendant already resolved', () => {
    // The reason invalidation clears rather than deletes one key: this
    // change alters the answer for a name the setter never mentions.
    const { logger, dest } = makeLogger();
    logger.minimumLevel('error');
    logger.info('before: filtered', undefined, 'net.http.client');

    logger.subsystem('net', 'info');
    logger.info('after: the parent applies', undefined, 'net.http.client');

    expect(dest.messages).toEqual(['after: the parent applies']);
  });

  test('resetting a PARENT is seen by a descendant already resolved', () => {
    const { logger, dest } = makeLogger();
    logger.minimumLevel('error').subsystem('net', 'info');
    logger.info('before: the parent allows it', undefined, 'net.http.client');

    logger.resetSubsystem('net');
    logger.info(
      'after: back to the global minimum',
      undefined,
      'net.http.client'
    );

    expect(dest.messages).toEqual(['before: the parent allows it']);
  });

  test('changing the global minimum is seen by a subsystem that falls back to it', () => {
    // `unconfigured` has no override at any depth, so its resolved answer IS
    // the global minimum — which makes it exactly the memo entry a later
    // `minimumLevel` call invalidates.
    const { logger, dest } = makeLogger();
    logger.minimumLevel('error');
    logger.info('before: filtered', undefined, 'unconfigured');

    logger.minimumLevel('debug');
    logger.info(
      'after: the new global minimum applies',
      undefined,
      'unconfigured'
    );

    expect(dest.messages).toEqual(['after: the new global minimum applies']);
  });

  test('a subsystem with its own level ignores a global minimum change', () => {
    const { logger, dest } = makeLogger();
    logger.minimumLevel('error').subsystem('av', 'info');
    logger.info('before', undefined, 'av');

    logger.minimumLevel('todo');
    logger.info(
      'after: still governed by the subsystem level',
      undefined,
      'av'
    );

    expect(dest.messages).toEqual([
      'before',
      'after: still governed by the subsystem level',
    ]);
  });

  test('resolution stays correct past the memo cap', () => {
    // The memo stops growing at MAX_MEMOIZED_SUBSYSTEMS so caller-supplied
    // names cannot accumulate for the life of the process. Past that point
    // resolution is simply not remembered — it must never be wrong, and it
    // must still follow a configuration change.
    const { logger, dest } = makeLogger();
    logger.minimumLevel('error').subsystem('kept', 'info');

    for (let i = 0; i < 600; i += 1) {
      logger.info('flood', undefined, `ephemeral.${i}`);
    }
    expect(dest.messages).toEqual([]);

    logger.info('configured subsystem still resolves', undefined, 'kept');
    logger.subsystem('late', 'info');
    logger.info('a name first seen after the cap', undefined, 'late');

    expect(dest.messages).toEqual([
      'configured subsystem still resolves',
      'a name first seen after the cap',
    ]);
  });
});
