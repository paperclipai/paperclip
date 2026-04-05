import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adapterRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(adapterRoot, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('shared Paperclip skills do not append a second /api segment to PAPERCLIP_API_URL', () => {
  const files = [
    'skills/paperclip/SKILL.md',
    'skills/paperclip-create-agent/SKILL.md',
    'skills/paperclip/references/company-skills.md',
  ];

  for (const file of files) {
    assert.doesNotMatch(read(file), /\$PAPERCLIP_API_URL\/api\//, file);
  }
});

test('Paperclip-facing skills declare core env passthrough for Hermes sandboxes', () => {
  const files = [
    'skills/paperclip/SKILL.md',
    'skills/paperclip-create-agent/SKILL.md',
    'packages/adapters/hermes-local/skills/paperclip/paperclip-runtime/SKILL.md',
    'packages/adapters/hermes-local/skills/paperclip/paperclip-api/SKILL.md',
    'packages/adapters/hermes-local/skills/paperclip/paperclip-approvals/SKILL.md',
  ];

  const requiredVars = [
    'PAPERCLIP_API_URL',
    'PAPERCLIP_COMPANY_ID',
    'PAPERCLIP_AGENT_ID',
    'PAPERCLIP_API_KEY',
    'PAPERCLIP_RUN_ID',
  ];

  for (const file of files) {
    const text = read(file);
    assert.match(text, /required_environment_variables:/, file);
    for (const envVar of requiredVars) {
      assert.match(text, new RegExp(`-\\s+${envVar}\\b`), `${file} missing ${envVar}`);
    }
  }
});

test('paperclip-create-agent teaches Hermes-safe hire submission patterns', () => {
  const text = read('skills/paperclip-create-agent/SKILL.md');
  assert.match(text, /PAPERCLIP_API_URL`?\s+already includes `?\/api/i);
  assert.match(text, /Do not use `execute_code` for Paperclip hire, approval, issue-comment, or issue-status API calls/i);
  assert.match(text, /`PAPERCLIP_\*` vars can resolve as missing or `None`/i);
  assert.match(text, /Do not use `write_file` for env-backed Paperclip payloads/i);
  assert.match(text, /use an unquoted delimiter like `<<JSON`, not `<<'JSON'`/i);
  assert.match(text, /confirm no literal `\$PAPERCLIP_\*` strings remain/i);
  assert.match(text, /X-Paperclip-Run-Id: \$PAPERCLIP_RUN_ID/);
  assert.match(text, /--data @\/tmp\/paperclip-agent-hire\.json/);
  assert.match(text, /"reportsTo": "\$PAPERCLIP_AGENT_ID"/);
});
