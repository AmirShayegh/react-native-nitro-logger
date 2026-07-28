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
