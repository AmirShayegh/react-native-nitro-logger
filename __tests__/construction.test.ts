/**
 * The construction path: `createFileDestination` and
 * `createNativeConsoleDestination`, and the `/unstable` barrel underneath them.
 *
 * These are the only functions in the package that name a Nitro hybrid object
 * by string. A typo in one of those strings is not a compile error and not a
 * test failure anywhere else — it is a runtime throw on a device, in the app's
 * first second, saying a module could not be found. So the strings are what
 * these tests are mostly about.
 *
 * `react-native-nitro-modules` is mocked because `createHybridObject` needs a
 * native runtime. That is the whole of the mock: what it returns stands in for
 * the sink, and the destinations are driven for real.
 *
 * What this does not prove: that a hybrid object registered under those names
 * exists in either native binary. Nothing in JavaScript can — it is what the
 * `min-rn-ios` and `min-rn-android` jobs are for, and what the README's setup
 * section describes the throw of.
 */
import type { FileSinkLike } from '../src/destinations/FileDestination';
import type { NativeConsoleSinkLike } from '../src/destinations/NativeConsoleDestination';
import { MemoryWriter } from './helpers/MemoryFileSink';

/** Jest's CommonJS module scope, which this tsconfig has no types for. */
declare const __dirname: string;

// `mock`-prefixed because Jest hoists the factory above these declarations
// and refuses to close over anything else.
const mockAsked: string[] = [];
let mockHandOut: (name: string) => unknown = () => undefined;

jest.mock('react-native-nitro-modules', () => ({
  NitroModules: {
    createHybridObject: (name: string) => {
      mockAsked.push(name);
      return mockHandOut(name);
    },
  },
}));

/** Enough of the native console sink to be constructed against. */
const consoleSink: NativeConsoleSinkLike = {
  install() {},
  logBatch() {},
};

let fileSink: FileSinkLike;

beforeEach(() => {
  jest.useFakeTimers();
  mockAsked.length = 0;
  fileSink = new MemoryWriter().attach();
  mockHandOut = (name) => (name === 'FileSink' ? fileSink : consoleSink);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the construction path', () => {
  test('createFileDestination asks for the FileSink hybrid object by name', () => {
    const { createFileDestination, FileDestination } =
      require('../src/index') as typeof import('../src/index');

    const destination = createFileDestination();

    expect(mockAsked).toEqual(['FileSink']);
    expect(destination).toBeInstanceOf(FileDestination);
    // Built on the object the factory was handed, not one of its own.
    expect(destination.filePath).toBe(
      `${fileSink.defaultLogDirectory}/app.log`
    );
  });

  test('createNativeConsoleDestination asks for NativeConsoleSink by name', () => {
    const { createNativeConsoleDestination, NativeConsoleDestination } =
      require('../src/index') as typeof import('../src/index');

    const destination = createNativeConsoleDestination();

    expect(mockAsked).toEqual(['NativeConsoleSink']);
    expect(destination).toBeInstanceOf(NativeConsoleDestination);
  });

  test('options reach the destination rather than being dropped', () => {
    const { createFileDestination } =
      require('../src/index') as typeof import('../src/index');
    const rotation = {
      maxFileSizeBytes: 2048,
      maxArchivedFilesCount: 2,
      compressArchives: false,
    };

    const destination = createFileDestination({
      label: 'audit',
      path: '/memory/logs/audit.log',
      rotation,
      minimumLevel: 'warning',
    });

    expect(destination.label).toBe('audit');
    expect(destination.filePath).toBe('/memory/logs/audit.log');
    expect(destination.minimumLevel).toBe('warning');
    // The open really happened, with the config, through the sink handed over.
    const opened = fileSink as unknown as {
      openedPath: string;
      openedRotation: unknown;
    };
    expect(opened.openedPath).toBe('/memory/logs/audit.log');
    expect(opened.openedRotation).toEqual(rotation);
  });

  test('the console options reach it too', () => {
    const { createNativeConsoleDestination } =
      require('../src/index') as typeof import('../src/index');
    const installed: Array<[string, string]> = [];
    mockHandOut = () => ({
      install: (subsystem: string, category: string) =>
        installed.push([subsystem, category]),
      logBatch() {},
    });

    const destination = createNativeConsoleDestination({
      label: 'oslog',
      subsystem: 'com.example.app',
      category: 'network',
    });

    expect(destination.label).toBe('oslog');
    expect(installed).toEqual([['com.example.app', 'network']]);
  });

  test('a factory that cannot build its sink throws rather than degrading', () => {
    const { createFileDestination } =
      require('../src/index') as typeof import('../src/index');
    mockHandOut = () => {
      throw new Error('NitroModules Turbo/Native-Module could not be found');
    };

    // The throw is the contract. A destination that silently writes nowhere is
    // worse than one that refuses to be constructed, and this is the failure a
    // consumer meets when the pods are not installed.
    expect(() => createFileDestination()).toThrow(/could not be found/);
  });

  test('the unstable barrel builds the same two sinks and nothing else', () => {
    const unstable =
      require('../src/unstable') as typeof import('../src/unstable');

    expect(Object.keys(unstable).sort()).toEqual([
      'createFileSink',
      'createNativeConsoleSink',
    ]);

    expect(unstable.createFileSink()).toBe(fileSink);
    expect(unstable.createNativeConsoleSink()).toBe(consoleSink);
    expect(mockAsked).toEqual(['FileSink', 'NativeConsoleSink']);
  });

  test('the raw sink factories are not on the root barrel', () => {
    const root = require('../src/index') as Record<string, unknown>;

    // The 0.3.0 break, pinned from the consumer's side. `/unstable` is not a
    // second spelling of a root export — it is the only way to these, which is
    // the whole point of moving them.
    expect(root.createFileSink).toBeUndefined();
    expect(root.createNativeConsoleSink).toBeUndefined();
    // And the replacement really is there, so this cannot pass by the barrel
    // failing to load.
    expect(typeof root.createFileDestination).toBe('function');
    expect(typeof root.createNativeConsoleDestination).toBe('function');
  });

  test('the hybrid-object names are spelled in exactly one place', () => {
    // Declared locally rather than imported: this tsconfig pins `types` to
    // react-native and jest with no `@types/node`, and adding a dependency so
    // one guard can read a directory is the worse trade. Same reasoning as the
    // `TextEncoder` declaration in `utf8.test.ts`.
    const { readFileSync, readdirSync } = require('fs') as {
      readFileSync(path: string, encoding: string): string;
      readdirSync(
        path: string,
        options: { withFileTypes: true }
      ): Array<{ name: string; isDirectory(): boolean }>;
    };
    const { join } = require('path') as {
      join(...parts: string[]): string;
    };

    // Two strings that fail at runtime on a device when wrong, and nowhere
    // earlier. One file may say them; anything else is a second place to drift.
    const root = join(__dirname, '..', 'src');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith('.ts') || e.name.endsWith('.tsx')
            ? [join(dir, e.name)]
            : []
      );

    const files = walk(root);
    expect(files.length).toBeGreaterThan(10);
    const callers = files.filter((f) =>
      /createHybridObject/.test(readFileSync(f, 'utf8'))
    );

    expect(callers.map((f) => f.slice(root.length + 1))).toEqual([
      'unstable.ts',
    ]);
  });
});
