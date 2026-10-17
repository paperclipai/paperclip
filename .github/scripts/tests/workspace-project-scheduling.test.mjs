import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = path.join(root, 'scripts/run-vitest-stable.mjs');
const args = [script, '--mode', 'general', '--group', 'general-workspaces-b'];
const plan = spawnSync(process.execPath, [...args, '--dry-run'], { cwd: root, encoding: 'utf8' });
assert.equal(plan.status, 0, plan.stderr);
const projects = JSON.parse(plan.stdout).workspaceProjects;

for (const variant of [
  { name: 'bounded parallel projects', workers: 4, peak: 2, perProject: 2 },
  { name: 'one available worker', workers: 1, peak: 1, perProject: 1 },
  { name: 'explicit shared database', workers: 4, peak: 1, perProject: 4, database: 'postgresql://fixture/shared' },
  { name: 'one failed project', workers: 4, peak: 2, perProject: 2, fail: true },
]) test(`workspace scheduling preserves coverage and isolation with ${variant.name}`, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'workspace-project-scheduling-'));
  const record = path.join(directory, 'events.jsonl');
  const pnpm = path.join(directory, 'pnpm');
  writeFileSync(pnpm, `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args[0] !== 'exec' || args[1] !== 'vitest' || args[2] !== 'run') process.exit(29);
    const project = args[args.indexOf('--project') + 1];
    const entry = { project, home:process.env.PAPERCLIP_HOME, config:process.env.PAPERCLIP_CONFIG,
      instance:process.env.PAPERCLIP_INSTANCE_ID, workers:process.env.VITEST_MAX_WORKERS, pid:process.pid };
    fs.appendFileSync(process.env.PC_SCHEDULING_RECORD, JSON.stringify({...entry, type:'start'})+'\\n');
    setTimeout(() => {
      fs.appendFileSync(process.env.PC_SCHEDULING_RECORD, JSON.stringify({...entry, type:'end'})+'\\n');
      process.exit(project === process.env.PC_SCHEDULING_FAIL_PROJECT ? 23 : 0);
    }, 50);
  `);
  chmodSync(pnpm, 0o755);
  try {
    const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      VITEST_MAX_WORKERS: String(variant.workers), PC_SCHEDULING_RECORD: record,
      PC_SCHEDULING_FAIL_PROJECT: variant.fail ? projects[0] : '', PAPERCLIP_CI_PROFILE: 'false' };
    if (variant.database) env.PAPERCLIP_TEST_DATABASE_URL = variant.database;
    else delete env.PAPERCLIP_TEST_DATABASE_URL;
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, variant.fail ? 1 : 0, result.stderr);
    const events = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const starts = events.filter(event => event.type === 'start');
    const ends = events.filter(event => event.type === 'end');
    assert.deepEqual(starts.map(event => event.project).sort(), [...projects].sort());
    assert.deepEqual(ends.map(event => event.project).sort(), [...projects].sort());
    let running = 0, peak = 0;
    for (const event of events) {
      running += event.type === 'start' ? 1 : -1;
      peak = Math.max(peak, running);
      assert.ok(running >= 0 && running <= variant.peak);
    }
    assert.equal(running, 0);
    assert.equal(peak, variant.peak);
    assert.ok(starts.every(event => Number(event.workers) === variant.perProject));
    for (const key of ['home', 'config', 'instance', 'pid']) {
      assert.equal(new Set(starts.map(event => event[key])).size, projects.length, key);
    }
  } finally {
    if (existsSync(record)) {
      for (const event of readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line))) {
        const parent = path.dirname(event.home);
        if (path.basename(parent).startsWith('pv-')) rmSync(parent, { recursive: true, force: true });
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
