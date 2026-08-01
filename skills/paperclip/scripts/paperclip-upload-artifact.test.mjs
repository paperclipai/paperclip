#!/usr/bin/env node
/**
 * Tests for paperclip-upload-artifact.sh authentication handling.
 *
 * Two properties are covered:
 *
 *  1. The bearer token never reaches curl's argv. Process arguments are
 *     world-readable through /proc/<pid>/cmdline on Linux, so a token passed
 *     as `-H "Authorization: Bearer $PAPERCLIP_API_KEY"` leaks to every
 *     process on the host. Auth must travel through a mode-600 curl config.
 *
 *  2. The token-bearing config file does not survive an interrupted run. The
 *     script pools its temp files under one workspace dir and removes it from
 *     a main-shell trap on EXIT/INT/TERM.
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
      // The one permitted mention is the SKILL.md-style warning; the script
      // itself must not build an -H Authorization argument at all.
      const argvHeader = /-H\s+(["'])Authorization:\s*Bearer[^\n]*\1/g;
      const matches = SOURCE.match(argvHeader) ?? [];
      assert.deepEqual(
        matches,
        [],
        `bearer token passed in curl argv (visible via /proc/*/cmdline):\n${matches.join('\n')}`
      );
    });

    it('sends auth through a mode-600 curl config file', () => {
      assert.match(SOURCE, /write_auth_config\(\)/, 'expected a write_auth_config helper');
      assert.match(SOURCE, /chmod 600/, 'auth config must be created mode 600');
      assert.match(SOURCE, /--config\s+"\$auth_cfg"/, 'curl must read auth from --config');
    });

    it('cleans up token files from a main-shell trap', () => {
      // request_json/upload_file run inside command substitutions, so a signal
      // sent to the script never reaches them. The trap has to be in the main
      // shell, over a workspace dir that owns every temp file.
      assert.match(SOURCE, /trap\s+\w+\s+EXIT\s+INT\s+TERM/, 'expected an EXIT/INT/TERM trap');
      assert.match(SOURCE, /mktemp -d/, 'expected a single mktemp -d workspace');
      assert.doesNotMatch(
        SOURCE,
        /^\s*(cfg|response_file)="\$\(mktemp\)"/m,
        'temp files must be created inside the trapped workspace (mktemp -p "$_WORKDIR")'
      );
    });
  });

  describe('interrupted run leaves no token on disk', () => {
    let server;
    let baseUrl;
    let tmpRoot;
    let payload;
    const sockets = new Set();

    before(async () => {
      // A server that accepts the request and never answers, so the script is
      // parked inside curl with its auth config already written to disk.
      server = createServer(() => {});
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
     * The process group matters. Signalling only the top-level bash does not
     * interrupt the run: bash is blocked waiting on curl inside a command
     * substitution, and it defers a trap until that foreground child returns.
     * With curl parked on a request that never answers, the trap would never
     * run. A real interruption — a terminal Ctrl-C, or a supervisor tearing a
     * run down — signals the whole group, which is what this models.
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

    it('removes the auth config when the run is terminated mid-request', async () => {
      const tmpdir = await fsp.mkdtemp(path.join(tmpRoot, 'run-'));
      const child = spawnScript(tmpdir);

      try {
        // Wait until the token is actually on disk. Without this the assertion
        // could pass simply because the script had not got that far yet.
        const written = await waitFor(async () => (await filesContainingToken(tmpdir)).length > 0);
        assert.ok(written, 'auth config holding the token was never written — test cannot conclude');

        signalGroup(child, 'SIGTERM');
        const exited = await Promise.race([once(child, 'exit'), sleep(10_000).then(() => null)]);
        assert.ok(exited, 'script did not exit within 10s of SIGTERM to its process group');

        const leaked = await filesContainingToken(tmpdir);
        assert.deepEqual(leaked, [], `token survived SIGTERM in: ${leaked.join(', ')}`);
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
