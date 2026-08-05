import { fixupConfigRules } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import { defineConfig } from 'eslint/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default defineConfig([
  {
    extends: fixupConfigRules(compat.extends('@react-native', 'prettier')),
    plugins: { prettier },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'prettier/prettier': 'error',
    },
  },
  {
    files: [
      'src/analytics.ts',
      'src/analytics/**/*.ts',
      'src/constraints.ts',
      'src/privacy.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Build output, not source. `android/build` in particular holds Gradle's
    // generated HTML test report, whose bundled JS is a few hundred prettier
    // violations that appear the moment anyone runs the Kotlin suite.
    ignores: [
      'node_modules/',
      'lib/',
      'android/build/',
      'example/android/build/',
      'example/android/app/build/',
      'nitrogen/',
    ],
  },
]);
