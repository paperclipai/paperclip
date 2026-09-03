#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const script = new URL('./check-security-overrides.mjs', import.meta.url).pathname;

function runWithPackageJson(pkg) {
  const dir = mkdtempSync(join(tmpdir(), 'security-overrides-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    return execFileSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, OVERRIDE_ROOT: dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('passes when all required security overrides are present', () => {
  const out = runWithPackageJson({
    pnpm: { overrides: { qs: '>=6.15.4', 'fast-uri': '>=3.1.3', rollup: '>=4.59.0' } },
  });
  assert.match(out, /security overrides present/);
});

test('fails when an override is missing', () => {
  assert.throws(
    () => runWithPackageJson({ pnpm: { overrides: { qs: '>=6.15.4' } } }),
    /fast-uri/,
  );
});

test('fails when an override is below the patched floor', () => {
  assert.throws(
    () => runWithPackageJson({ pnpm: { overrides: { qs: '>=6.14.0', 'fast-uri': '>=3.1.3' } } }),
    /qs.*at least/,
  );
});
