#!/usr/bin/env node
/**
 * Tests for paperclip-upload-artifact.sh authentication handling.
 *
 * The bearer token must never be readable by anything but curl itself, which
 * means two things:
 *
 *  1. It never reaches curl's argv. Process arguments are world-readable
 *     through /proc/<pid>/cmdline on Linux, so `-H "Authorization: Bearer
 *     $PAPERCLIP_API_KEY"` hands the credential to every process on the host.
 *
 *  2. It never reaches disk. Writing it to a mode-600 temp file satisfies (1)
 *     but leaves a credential that has to be deleted, and a deletion can
 *     always be skipped: bash defers a trap while curl holds the foreground,
 *     and SIGKILL skips it outright. The script pipes the config into
 *     `curl --config -` instead, so there is nothing to clean up.
 *
 * Run: node --test skills/paperclip/scripts/paperclip-upload-artifact.test.mjs
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./paperclip-upload-artifact.sh', import.meta.url));
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');

// Executable lines only. Comments legitimately quote the unsafe pattern to say
// what not to do, and that prose must not trip the checks below.
const CODE = SOURCE.split('\n')
  .filter(line => !/^\s*#/.test(line))
  .join('\n');

// A value distinctive enough that finding it on disk is unambiguous.
const SENTINEL_TOKEN = 'sentinel-token-4f8a2c91-do-not-use';

/** Recursively collect every file under `dir` (empty if dir is gone). */
async function walk(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/** Every file under `dir` whose bytes contain the sentinel token. */
async function filesContainingToken(dir) {
  const hits = [];
  for (const file of await walk(dir)) {
    try {
      if ((await fsp.readFile(file, 'utf8')).includes(SENTINEL_TOKEN)) hits.push(file);
    } catch {
      // Unreadable or vanished mid-scan — not a leak.
    }
  }
  return hits;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Every running process whose arguments contain the token, as `pid: cmdline`.
 * Linux only — this is the exposure the fix exists to prevent, so it is worth
 * asserting against the real kernel view rather than only against the source.
 */
async function argvExposingToken() {
  const hits = [];
  for (const pid of await fsp.readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmdline = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8');
      if (cmdline.includes(SENTINEL_TOKEN)) {
        hits.push(`${pid}: ${cmdline.replace(/\0/g, ' ').trim()}`);
      }
    } catch {
      // Process exited mid-scan, or not ours to read.
    }
  }
  return hits;
}

/** Poll `predicate` until truthy or `timeoutMs` elapses. */
async function waitFor(predicate, timeoutMs = 10_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

describe('paperclip-upload-artifact.sh auth handling', () => {
  describe('token never reaches curl argv', () => {
    it('passes no Authorization header as a curl argument', () => {
      const argvHeader = /-H\s+(["'])Authorization:\s*Bearer[^\n]*\1/g;
      const matches = CODE.match(argvHeader) ?? [];
      assert.deepEqual(
        matches,
        [],
        `bearer token passed in curl argv (visible via /proc/*/cmdline):\n${matches.join('\n')}`
      );
    });

    it('sends auth through a curl config piped on stdin', () => {
      assert.match(CODE, /write_auth_config\(\)/, 'expected a write_auth_config helper');
      assert.match(
        CODE,
        /write_auth_config \| curl[\s\S]{0,200}?--config -/,
        'curl must read auth from --config - (stdin)'
      );
    });

    it('never writes the token to a file', () => {
      // A temp file keeps the token out of argv but still has to be deleted,
      // and a deletion can always be skipped — a deferred trap while curl
      // hangs, or SIGKILL. Piping the config leaves nothing to clean up.
      assert.doesNotMatch(
        CODE,
        /PAPERCLIP_API_KEY"?\s*>>?\s*"?\$/,
        'the token must never be redirected into a file'
      );
      assert.doesNotMatch(
        CODE,
        /--config\s+"\$\w+"/,
        'auth must not be read from a temp file on disk'
      );
    });
  });

  describe('credential never reaches disk or argv', () => {
    let server;
    let baseUrl;
    let tmpRoot;
    let payload;
    let requestsSeen = 0;
    const sockets = new Set();

    before(async () => {
      // A server that accepts the request and never answers, so the script sits
      // parked inside curl with the credential in play.
      server = createServer(() => {
        requestsSeen += 1;
      });
      server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      server.unref();
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'upload-artifact-test-'));
      payload = path.join(tmpRoot, 'artifact.txt');
      await fsp.writeFile(payload, 'artifact body\n');
    });

    after(async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      server.close();
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    });

    /**
     * Spawn the script with TMPDIR isolated so we can audit everything it
     * writes, and `detached` so it leads its own process group.
     *
     * The group matters for teardown. The script is parked on a request that
     * never answers, and signalling only the top-level bash would not stop it:
     * bash blocks on curl inside a command substitution and defers signals
     * until that foreground child returns. Killing the group takes curl too.
     */
    function spawnScript(tmpdir) {
      return spawn('bash', [SCRIPT, payload, '--no-work-product'], {
        detached: true,
        env: {
          ...process.env,
          TMPDIR: tmpdir,
          PAPERCLIP_API_URL: baseUrl,
          PAPERCLIP_API_KEY: SENTINEL_TOKEN,
          PAPERCLIP_COMPANY_ID: 'company-test',
          PAPERCLIP_TASK_ID: 'issue-test',
          PAPERCLIP_RUN_ID: 'run-test',
        },
        stdio: 'ignore',
      });
    }

    /** Signal the whole process group, ignoring an already-dead group. */
    function signalGroup(child, signal) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Group already gone.
      }
    }

    it('keeps the token off disk while a request is in flight', async () => {
      const tmpdir = await fsp.mkdtemp(path.join(tmpRoot, 'run-'));
      const child = spawnScript(tmpdir);

      try {
        // Park until the request has actually reached the server, so the script
        // is provably mid-request rather than not yet started.
        const reached = await waitFor(() => requestsSeen > 0);
        assert.ok(reached, 'script never issued a request — test cannot conclude');

        // The credential must not exist anywhere on disk at this moment. This
        // is the property a temp file cannot give: with a file, cleanup depends
        // on a deletion that an interrupted run may never perform.
        const onDisk = await filesContainingToken(tmpdir);
        assert.deepEqual(onDisk, [], `token written to disk mid-request: ${onDisk.join(', ')}`);

        // And it must not be visible in any process's arguments.
        if (process.platform === 'linux') {
          const exposed = await argvExposingToken();
          assert.deepEqual(exposed, [], `token visible in process argv: ${exposed.join(', ')}`);
        }
      } finally {
        // Never let a stray group keep the test runner alive.
        signalGroup(child, 'SIGKILL');
      }
    });

    it('leaves no workspace behind on an early-exit path', async () => {
      const tmpdir = await fsp.mkdtemp(path.join(tmpRoot, 'help-'));
      const child = spawn('bash', [SCRIPT, '--help'], {
        env: { ...process.env, TMPDIR: tmpdir, PAPERCLIP_API_KEY: SENTINEL_TOKEN },
        stdio: 'ignore',
      });
      await once(child, 'exit');

      assert.deepEqual(await walk(tmpdir), [], 'early exit left temp files behind');
    });
  });
});
