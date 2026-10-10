// A selector for existing Vitest checks, not a model runner or a live Slack grader.
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const catalog = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
if (catalog.schema !== 'paperclip.slack_connector_probes.v1' || catalog.version !== 1 || !Array.isArray(catalog.cases) || !catalog.cases.length) {
  throw new Error('Invalid Slack probe catalog');
}
const args = process.argv.slice(2);
const knownIds = new Set();
for (const entry of catalog.cases) {
  if (!entry.id || knownIds.has(entry.id) || !entry.prompt || !entry.oracle || !entry.requiredEvidence?.length || !entry.regressionFiles?.length) {
    throw new Error('Invalid Slack probe definition');
  }
  knownIds.add(entry.id);
  for (const file of entry.regressionFiles) {
    if (!file.endsWith('.test.ts') || !file.startsWith('server/src/') || file.includes('..')) throw new Error('Invalid regression path');
    await access(path.join(root, file));
  }
}
if (args.length === 1 && args[0] === '--list') {
  for (const entry of catalog.cases) console.log(`${entry.id}: ${entry.prompt}`);
  console.log('\nModel probes: manual / not registered in Product E2E. Regression selection makes no model or Slack calls.');
} else {
  const selected = args.length === 0 ? catalog.cases
    : args.length === 2 && args[0] === '--case' ? catalog.cases.filter(entry => entry.id === args[1]) : [];
  if (!selected.length) {
    console.error('Use --list, --case <id>, or no arguments for all deterministic regressions.');
    process.exitCode = 2;
  } else {
    const files = [...new Set(selected.flatMap(entry => entry.regressionFiles))];
    console.log(`Slack deterministic checks for: ${selected.map(entry => entry.id).join(', ')}. This does not grade the manual model probes.`);
    const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'vitest', 'run', ...files], { cwd: root, stdio: 'inherit' });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
  }
}
