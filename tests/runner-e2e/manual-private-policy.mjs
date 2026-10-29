import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonicalManualIds, canonicalPrivateManualIds, MANUAL_PRIVATE_EXECUTIONS, requiresPrivateManualEvidence } from './manual-private-retention.ts';

const values = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
export function manualEvidenceRouting(env) {
  if (env.EVENT_NAME !== 'workflow_dispatch' || env.EVAL_CADENCE !== 'manual') return { retention: 'recurring', executionIds: [] };
  const ids = values(env.SELECT_ID), selectors = ['SELECT_SUITE', 'SELECT_GROUP', 'SELECT_PROFILE', 'SELECT_ENVIRONMENT', 'SELECT_CASE'];
  if ((env.SELECT_ID ?? '') && selectors.some(key => env[key])) throw new Error('Exact IDs are exclusive with other selectors');
  if (!ids.length) {
    if (values(env.SELECT_SUITE).includes('chat-features')) throw new Error('Explicit reviewed IDs required for private manual execution');
    return { retention: 'actions', executionIds: [] };
  }
  if (!ids.some(requiresPrivateManualEvidence)) return { retention: 'actions', executionIds: ids };
  const selected = canonicalPrivateManualIds(ids);
  if (selected.some(id => !MANUAL_PRIVATE_EXECUTIONS.includes(id))) throw new Error('Unsupported private manual selection');
  if (env.TEST_RUNNER !== 'runs-on/fleet=paperclip-public-pr-x64/env=public-ci') throw new Error('Private manual evidence currently requires the reviewed AWS route');
  return { retention: 'private', executionIds: selected };
}
export function authorizeManualCellRoute(retention, executionId, privateIds) {
  const ids = canonicalManualIds([executionId]);
  if (retention === 'private') {
    if (!MANUAL_PRIVATE_EXECUTIONS.includes(ids[0]) || !canonicalPrivateManualIds(JSON.parse(privateIds)).includes(ids[0])) throw new Error('Private cell differs from trusted selection');
    return 'private';
  }
  if (retention !== 'actions' || requiresPrivateManualEvidence(ids[0])) throw new Error('Sensitive cell cannot enter public manual artifacts');
  return 'actions';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'cell') {
      const route = authorizeManualCellRoute(process.env.EVIDENCE_RETENTION, process.env.SELECTED_EXECUTION_ID, process.env.MANUAL_PRIVATE_IDS);
      appendFileSync(process.env.GITHUB_OUTPUT, `route=${route}\n`);
    } else {
      const result = manualEvidenceRouting(process.env);
      appendFileSync(process.env.GITHUB_OUTPUT, `evidence_retention=${result.retention}\nmanual_private_ids=${JSON.stringify(result.executionIds)}\n`);
    }
  } catch { process.stderr.write('Manual evidence authorization failed before paid access; details withheld\n'); process.exitCode = 1; }
}
