import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPrBody } from './pr-body.mjs';

test('renderPrBody includes replay status, translated files, validation results, and manual review items', () => {
  const body = renderPrBody({
    branchName: 'bot-upgrade/abc123def456',
    status: 'replayed',
    upstreamRef: 'upstream/v1.2.3',
    maintenanceRef: 'origin/zh-enterprise',
    commits: ['c1', 'c2'],
    diagnostics: {
      conflicts: [],
    },
    translationSummary: {
      mode: 'auto-translate',
      translatedFiles: ['ui/src/lib/inbox-copy.ts'],
      translatedEntryCount: 2,
    },
    validationSummary: {
      status: 'failed',
      uiTypecheck: {
        status: 'passed',
        summary: 'UI typecheck passed.',
      },
      serverTypecheck: {
        status: 'failed',
        summary: 'Server typecheck failed with exit code 1.',
      },
      checkI18n: {
        status: 'passed',
        summary: 'check:i18n passed.',
      },
    },
    localizationSummary: {
      manualReviewItems: [
        {
          type: 'markdown-review',
          path: 'docs/start/quickstart-zh-cn.md',
          sourcePath: 'docs/start/quickstart.md',
          reason: 'english-changed',
        },
        {
          type: 'copy-stale',
          path: 'ui/src/lib/inbox-copy.ts',
          key: 'legacyCta',
          chinese: '了解更多',
          baselineEnglish: 'Learn more',
        },
      ],
    },
    failure: {
      stage: 'scan-localization',
      message: 'localization scan failed',
    },
  });

  assert.match(body, /# Upstream sync/);
  assert.match(body, /- replay status: `replayed`/);
  assert.match(body, /- upstream ref\/tag: `upstream\/v1\.2\.3`/);
  assert.match(body, /- merge strategy: `rebase` only/);
  assert.match(body, /- conflicts: none/);
  assert.match(body, /## Failure/);
  assert.match(body, /- stage: `scan-localization`/);
  assert.match(body, /- message: localization scan failed/);
  assert.match(body, /## Auto-translated files/);
  assert.match(body, /ui\/src\/lib\/inbox-copy\.ts/);
  assert.match(body, /## Validation/);
  assert.match(body, /overall: `failed`/);
  assert.match(body, /ui typecheck: `passed` — UI typecheck passed\./);
  assert.match(body, /server typecheck: `failed` — Server typecheck failed with exit code 1\./);
  assert.match(body, /check:i18n: `passed` — check:i18n passed\./);
  assert.match(body, /## Manual review items/);
  assert.match(body, /docs\/start\/quickstart-zh-cn\.md/);
  assert.match(body, /legacyCta/);
});
