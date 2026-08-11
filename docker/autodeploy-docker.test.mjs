/**
 * Unit checks for docker/autodeploy-docker.sh helpers.
 * Run: node --test docker/autodeploy-docker.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, 'autodeploy-docker.sh');

test('autodeploy script has valid bash syntax', () => {
  execFileSync('bash', ['-n', scriptPath], { stdio: 'pipe' });
});

test('rejects --admin-password on argv to avoid process-list leaks', () => {
  let failed = false;
  try {
    execFileSync('bash', [scriptPath, 'local-auth', '--admin-password', 'secret'], {
      stdio: 'pipe',
      env: { ...process.env, PATH: process.env.PATH },
    });
  } catch (err) {
    failed = true;
    const msg = `${err.stderr?.toString?.() || ''}${err.stdout?.toString?.() || ''}`;
    assert.match(msg, /admin-password-file|PAPERCLIP_ADMIN_PASSWORD|command line/i);
  }
  assert.equal(failed, true, 'expected script to reject --admin-password');
});

test('dotenv_escape round-trips quotes hashes and spaces', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paperclip-autodeploy-'));
  const outFile = path.join(dir, 'out.env');
  const helpersFile = path.join(dir, 'helpers.sh');
  try {
    writeFileSync(
      helpersFile,
      execFileSync(
        'sed',
        ['-n', '/^dotenv_escape()/,/^}/p; /^write_dotenv_kv()/,/^}/p; /^reject_control_chars()/,/^}/p', scriptPath],
        { encoding: 'utf8' }
      )
    );
    const bash = `
set -euo pipefail
# shellcheck source=/dev/null
source "${helpersFile}"
die() { echo "$*" >&2; exit 1; }
: > "${outFile}"
write_dotenv_kv AUTOMATED_ADMIN_EMAIL 'a+b@example.com' >> "${outFile}"
write_dotenv_kv AUTOMATED_ADMIN_PASSWORD 'p@ss # "word" \$HOME \${USER}' >> "${outFile}"
write_dotenv_kv AUTOMATED_ADMIN_NAME 'Ada Lovelace' >> "${outFile}"
`;
    execFileSync('bash', ['-c', bash], { stdio: 'pipe' });
    const body = readFileSync(outFile, 'utf8');
    assert.match(body, /AUTOMATED_ADMIN_EMAIL="a\+b@example\.com"/);
    // Compose needs $$ so a literal $ survives env_file interpolation.
    assert.match(body, /AUTOMATED_ADMIN_PASSWORD="p@ss # \\"word\\" \$\$HOME \$\$\{USER\}"/);
    assert.match(body, /AUTOMATED_ADMIN_NAME="Ada Lovelace"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reject_control_chars blocks newlines in admin fields', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paperclip-autodeploy-'));
  const helpersFile = path.join(dir, 'helpers.sh');
  try {
    writeFileSync(
      helpersFile,
      execFileSync('sed', ['-n', '/^reject_control_chars()/,/^}/p', scriptPath], { encoding: 'utf8' })
    );
    const bash = `
set -euo pipefail
# shellcheck source=/dev/null
source "${helpersFile}"
die() { echo "$*" >&2; exit 2; }
reject_control_chars "Admin password" $'line1\\nline2'
`;
    let code = 0;
    try {
      execFileSync('bash', ['-c', bash], { stdio: 'pipe' });
    } catch (err) {
      code = err.status ?? 1;
    }
    assert.notEqual(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
