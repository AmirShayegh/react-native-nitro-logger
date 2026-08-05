'use strict';

const fs = require('fs');
const path = require('path');

const mutantsDirectory = path.join(__dirname, '..', 'scripts', 'mutants');
const manifest = require('../scripts/mutants/manifest.json');

describe('mutation manifest evidence', () => {
  test('registers every T-082 cyclic provenance regression', () => {
    const expected = [
      {
        id: 'E38-receiver-cycle-incomplete',
        patch: 'E38-receiver-cycle-incomplete.patch',
        target: 'eslint-plugin/event-receiver.js',
        test: 'pins cyclic receiver cache warm orders for ISS-005',
      },
      {
        id: 'E38-method-cycle-incomplete',
        patch: 'E38-method-cycle-incomplete.patch',
        target: 'eslint-plugin/event-method.js',
        test: 'pins cyclic method cache warm orders for ISS-006',
      },
      {
        id: 'E38-factory-namespace-scc-publication',
        patch: 'E38-factory-namespace-scc-publication.patch',
        target: 'eslint-plugin/event-factory.js',
        test: 'pins factory and namespace cache warm orders for ISS-007',
      },
    ];

    for (const evidence of expected) {
      expect(manifest.mutants).toContainEqual(
        expect.objectContaining({
          id: evidence.id,
          patch: evidence.patch,
          target: evidence.target,
          expect_red: expect.objectContaining({
            suite: '__tests__/analyticsEslintPlugin.test.js',
            test: evidence.test,
          }),
        })
      );
      expect(fs.existsSync(path.join(mutantsDirectory, evidence.patch))).toBe(
        true
      );
    }
  });
});
