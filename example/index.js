import { AppRegistry } from 'react-native';
import App from './src/App';
import C13ReloadHarness from './src/C13ReloadHarness';
import BenchHarness from './src/BenchHarness';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);

// Rendered only by `C13HarnessActivity`, which the instrumented reload test
// launches. Registered here because a component the runtime cannot find is not
// a component a reload can bring back.
AppRegistry.registerComponent('C13ReloadHarness', () => C13ReloadHarness);

// Rendered only by `BenchHarnessActivity`, which
// `scripts/bench-hermes-android.sh` starts with a per-run ID.
AppRegistry.registerComponent('BenchHarness', () => BenchHarness);
