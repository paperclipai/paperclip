#!/usr/bin/env node
/**
 * Asserts that pnpm overrides pin every package flagged by Dependabot with
 * an unresolvable transitive alert. Dependabot cannot update these itself
 * (`update_not_possible`), so a missing override leaves the alert open
 * until the next refresh bot run regenerates the lockfile.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = process.env.OVERRIDE_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
const overrides = pkg.pnpm?.overrides ?? {};

const REQUIRED_OVERRIDES = {
  qs: '>=6.15.4',
  'fast-uri': '>=3.1.3',
};

for (const [name, minVersion] of Object.entries(REQUIRED_OVERRIDES)) {
  assert.ok(
    overrides[name],
    `pnpm.overrides must pin "${name}" — Dependabot cannot resolve this transitive dependency itself`,
  );
  assert.match(
    String(overrides[name]),
    new RegExp(`^${minVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    `pnpm.overrides["${name}"] must be at least "${minVersion}", got "${overrides[name]}"`,
  );
}

console.log('security overrides present:', Object.keys(REQUIRED_OVERRIDES).join(', '));
