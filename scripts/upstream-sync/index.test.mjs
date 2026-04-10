import assert from 'node:assert/strict';
import test from 'node:test';

import { main } from './index.mjs';

test('main prints workflow-consumable validation outputs', async () => {
  let output = '';

  const result = await main([], {}, {
    runUpstreamSync: async () => ({
      branchName: 'bot-upgrade/abc123def456',
      reportPath: 'reports/upstream-sync-report.json',
      prBodyPath: 'reports/upstream-sync-pr-body.md',
      status: 'replayed',
      validationStatus: 'passed',
      readyForPr: true,
      validationLogPath: 'reports/upstream-sync-validation-log.json',
    }),
    parseSyncConfig: () => ({ dryRun: false }),
    stdout: {
      write(chunk) {
        output += chunk;
      },
    },
  });

  assert.equal(result.readyForPr, true);
  assert.match(output, /^branch_name=bot-upgrade\/abc123def456$/m);
  assert.match(output, /^report_path=reports\/upstream-sync-report\.json$/m);
  assert.match(output, /^pr_body_path=reports\/upstream-sync-pr-body\.md$/m);
  assert.match(output, /^status=replayed$/m);
  assert.match(output, /^validation_status=passed$/m);
  assert.match(output, /^ready_for_pr=true$/m);
  assert.match(output, /^validation_log_path=reports\/upstream-sync-validation-log\.json$/m);
});
