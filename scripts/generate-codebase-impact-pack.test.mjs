import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildImpactSummary,
  classifyChangedFile,
  extractLastJsonObject,
  parseArgs,
  parseGitStatusShort,
  renderImpactPack,
  suggestVerification,
} from './generate-codebase-impact-pack.mjs';

test('extractLastJsonObject skips log lines and parses final JSON', () => {
  const parsed = extractLastJsonObject('level=info msg=mem.init\n{"ok":true,"count":2}\n');
  assert.deepEqual(parsed, { ok: true, count: 2 });
});

test('parseGitStatusShort preserves tracked and untracked paths', () => {
  assert.deepEqual(parseGitStatusShort(' M server/src/services/heartbeat.ts\n?? scripts/tool.mjs\nR  old.ts -> new.ts\n'), [
    { status: 'M', path: 'server/src/services/heartbeat.ts' },
    { status: '??', path: 'scripts/tool.mjs' },
    { status: 'R', path: 'new.ts' },
  ]);
});

test('classifyChangedFile maps Paperclip surfaces', () => {
  assert.equal(classifyChangedFile('server/src/routes/agents.ts'), 'server route');
  assert.equal(classifyChangedFile('server/src/services/ceo-control-room.ts'), 'server service');
  assert.equal(classifyChangedFile('packages/shared/src/types/ceo-control-room.ts'), 'shared contract');
  assert.equal(classifyChangedFile('packages/adapters/claude-local/src/server/execute.ts'), 'adapter');
  assert.equal(classifyChangedFile('ui/src/pages/Dashboard.tsx'), 'ui');
  assert.equal(classifyChangedFile('scripts/generate-codebase-impact-pack.mjs'), 'tooling');
});

test('suggestVerification recommends focused commands by touched surface', () => {
  const commands = suggestVerification([
    'server/src/services/ceo-control-room.ts',
    'packages/adapters/claude-local/src/server/execute.ts',
    'ui/src/pages/Dashboard.tsx',
  ]).join('\n');
  assert.match(commands, /ceo-control-room-classification\.test\.ts/);
  assert.match(commands, /adapter-claude-local typecheck/);
  assert.match(commands, /@paperclipai\/ui typecheck/);
  assert.match(commands, /detect_changes/);
});

test('buildImpactSummary merges MCP changes with git status and render includes acceptance checklist', () => {
  const summary = buildImpactSummary({
    project: 'root-paperclip',
    repo: '/tmp/paperclip',
    maxSymbols: 3,
    detectChanges: {
      changed_files: ['server/src/services/ceo-control-room.ts'],
      impacted_symbols: [
        { name: 'ceoControlRoomService', label: 'Function', file: 'server/src/services/ceo-control-room.ts', qualified_name: 'root-paperclip.server.src.services.ceo-control-room.ceoControlRoomService' },
        { name: 'status', label: 'Function', file: 'server/src/services/ceo-control-room.ts', qualified_name: 'root-paperclip.server.src.services.ceo-control-room.status' },
      ],
    },
    gitStatus: [{ status: '??', path: 'scripts/generate-codebase-impact-pack.mjs' }],
  });
  assert.equal(summary.changedCount, 2);
  assert.equal(summary.filesByClass['server service'].length, 1);
  assert.equal(summary.filesByClass.tooling.length, 1);
  const markdown = renderImpactPack(summary);
  assert.match(markdown, /# Codebase Impact Pack/);
  assert.match(markdown, /ceoControlRoomService/);
  assert.match(markdown, /Operator acceptance checklist/);
});

test('parseArgs supports project, repo, output, max symbols and json', () => {
  assert.deepEqual(parseArgs(['--project', 'root-paperclip', '--repo', '/repo', '--output', 'out.md', '--max-symbols', '12', '--json']), {
    project: 'root-paperclip',
    repo: '/repo',
    output: 'out.md',
    maxSymbols: 12,
    cbm: process.env.CODEBASE_MEMORY_MCP_BIN || '/root/.local/bin/codebase-memory-mcp',
    json: true,
  });
});
