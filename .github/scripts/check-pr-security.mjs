#!/usr/bin/env node
/**
 * check-pr-security.mjs
 * Runs 6 security checks against a PR diff. Never posts public comments.
 * Creates a draft security advisory in the repo if any check fires.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR
 * Exit: always 0 — security flags are silent, never block the PR visibly.
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';
import { resolveBaseRef } from './check-pr-dependencies.mjs';

// ── Pure check functions (exported for testing) ───────────────────────────────

const SECRET_PATTERNS = [
  { name: 'OpenAI API key', re: /sk-[a-zA-Z0-9]{32,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key', re: /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/ },
  { name: 'High-entropy secret', re: /[a-zA-Z_]*(key|token|secret|password|credential)[a-zA-Z_]*\s*[=:]\s*["'][^"']{20,}["']/i },
];

export function scanSecrets(files) {
  const flags = [];
  for (const file of files) {
    if (!file.patch) continue;
    const added = file.patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    for (const line of added) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(line)) {
          flags.push({ check: 'secret-scan', file: file.filename, pattern: name, line: line.slice(0, 120) });
        }
      }
    }
  }
  return flags;
}

const CI_BUILD_SCRIPTS = [
  'scripts/release.sh',
  'scripts/check-docker-deps-stage.mjs',
  'scripts/check-release-package-bootstrap.mjs',
  'scripts/release-package-map.mjs',
  'scripts/docker-onboard-smoke.sh',
];

export function scanCITampering(files) {
  return files
    .filter(f => f.filename.startsWith('.github/workflows/') && f.status !== 'removed')
    .map(f => ({ check: 'ci-tampering', file: f.filename }));
}

export function scanBuildScripts(files) {
  return files
    .filter(f => CI_BUILD_SCRIPTS.includes(f.filename) && f.status !== 'removed')
    .map(f => ({ check: 'build-script-change', file: f.filename }));
}

export function scanSupplyChain(files) {
  const lockfile = files.find(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfile?.patch) return [];

  const added = new Set();
  const removed = new Set();

  for (const line of lockfile.patch.split('\n')) {
    const entry = parseLockfilePackageDiffEntry(line);
    if (!entry) continue;
    if (entry.sign === '+') added.add(entry.packageName);
    if (entry.sign === '-') removed.add(entry.packageName);
  }

  const netNew = [...added].filter(p => !removed.has(p));
  return netNew.length ? [{ check: 'supply-chain', packages: netNew }] : [];
}

function parseLockfilePackageDiffEntry(line) {
  const match = line.match(/^([+-])\s*(.+?)\s*$/);
  if (!match) return null;

  let [, sign, rawEntry] = match;
  if (!rawEntry.endsWith(':')) return null;

  rawEntry = rawEntry.slice(0, -1).trim();
  if ((rawEntry.startsWith("'") && rawEntry.endsWith("'")) || (rawEntry.startsWith('"') && rawEntry.endsWith('"'))) {
    rawEntry = rawEntry.slice(1, -1);
  }
  rawEntry = rawEntry.replace(/\(.*$/, '').trim();

  const versionSep = rawEntry.lastIndexOf('@');
  if (versionSep <= 0 || versionSep === rawEntry.length - 1) return null;

  const packageName = rawEntry.slice(0, versionSep);
  if (!/^(?:@[^/\s:]+\/)?[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(packageName)) return null;

  return { sign, packageName };
}

const TEST_FILE_RE = /\.(test|spec)\.(ts|js|tsx|jsx)$|\/(?:__tests__|tests?)\//;
const SUSPICIOUS_PATTERNS = [
  { name: 'outbound-network', re: /\+.*(fetch\(|axios\.|http\.request|https\.request)/ },
  { name: 'env-var-read', re: /\+.*process\.env\.(?!(?:NODE_ENV|CI|TEST|VITEST|npm_))([A-Z_]{4,})/ },
  { name: 'shell-exec', re: /\+.*(execSync\(|spawnSync\(|exec\(|spawn\()/ },
  { name: 'absolute-file-read', re: /\+.*(readFile|readFileSync)\s*\(\s*["'`]?\// },
];

export function scanTestPatterns(files) {
  const flags = [];
  for (const file of files) {
    if (!TEST_FILE_RE.test(file.filename) || !file.patch) continue;
    for (const { name, re } of SUSPICIOUS_PATTERNS) {
      if (re.test(file.patch)) {
        flags.push({ check: 'suspicious-test', file: file.filename, pattern: name });
      }
    }
  }
  return flags;
}

const SENSITIVE_PATHS = [
  // Advisory 1: codex-local adapter (inherited ChatGPT/Gmail OAuth scopes)
  'packages/adapters/codex-local/',
  // Advisory 2 & 11: OS command injection / privilege escalation via provisionCommand / cleanupCommand
  'server/src/services/workspace-realization.ts',
  'server/src/routes/execution-workspaces.ts',
  'server/src/routes/workspace-command-authz.ts',
  // Advisory 3 & 6: Cross-tenant agent API key minting and IDOR on /agents/:id/keys
  'server/src/routes/agents.ts',
  // Advisory 4: Approval decision attribution spoofing via decidedByUserId
  'server/src/routes/approvals.ts',
  // Advisory 5: Stored XSS via javascript: URLs in MarkdownBody (urlTransform)
  'ui/src/components/MarkdownBody.tsx',
  // Advisory 7: Unauthenticated access to authenticated-mode endpoints
  'server/src/routes/authz.ts',
  // Advisory 8: Unauthenticated RCE via import authorization bypass
  'server/src/routes/companies.ts',
  // Advisory 9: Malicious skills able to exfiltrate / destroy user data
  'server/src/routes/company-skills.ts',
  // Advisory 10: Arbitrary file read via agent-controlled instructionsFilePath
  'server/src/services/agent-instructions.ts',
];

export function scanSensitivePaths(files) {
  return files
    .filter(f => f.status !== 'removed' && SENSITIVE_PATHS.some(p => f.filename.startsWith(p)))
    .map(f => ({
      check: 'sensitive-path',
      file: f.filename,
      advisoryPath: SENSITIVE_PATHS.find(p => f.filename.startsWith(p)),
    }));
}

function buildContentsPath(repo, filename, ref) {
  return `/repos/${repo}/contents/${filename}?${new URLSearchParams({ ref }).toString()}`;
}

export async function validateSensitivePaths(token, repo, prNumber, baseRef, fetchFromGitHub = ghFetch) {
  const resolvedBaseRef = await resolveBaseRef(fetchFromGitHub, token, repo, prNumber, baseRef);
  const stale = [];
  await Promise.all(SENSITIVE_PATHS.map(async (path) => {
    try {
      await fetchFromGitHub(buildContentsPath(repo, path, resolvedBaseRef), token);
    } catch (err) {
      // 404 means the file/directory no longer exists at this path
      if (String(err.message).includes('404')) stale.push(path);
      // Other errors (network, rate limit) — re-throw so we don't silently miss them
      else throw err;
    }
  }));
  return stale;
}

// ── Advisory creation ─────────────────────────────────────────────────────────

const SEVERITY_MAP = {
  'supply-chain': 'critical',
  'sensitive-path': 'critical',
  'secret-scan': 'high',
  'ci-tampering': 'high',
  'suspicious-test': 'high',
  'build-script-change': 'medium',
};

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function worstSeverity(flags) {
  return flags.reduce((worst, f) => {
    const s = SEVERITY_MAP[f.check] ?? 'medium';
    return SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst;
  }, 'low');
}

export function buildAdvisoryPayload(prNumber, prTitle, flags) {
  const checkNames = [...new Set(flags.map(f => f.check))].join(', ');
  return {
    summary: `🚨 Security flag — PR #${prNumber}: ${checkNames}`,
    description: [
    `**PR:** #${prNumber} — ${prTitle}`,
    `**Checks triggered:** ${checkNames}`,
    '',
    '**Details:**',
    ...flags.map(f => [
      `- \`${f.check}\`: ${f.file ?? ''}`,
      f.pattern ? ` (pattern: ${f.pattern})` : '',
      f.packages ? ` (packages: ${f.packages.join(', ')})` : '',
      f.line ? `\n  \`${f.line}\`` : '',
    ].join('')),
    '',
    '> This advisory was created automatically by commitperclip. Review and dismiss if not a real concern.',
    ].join('\n'),
    severity: worstSeverity(flags),
    // vulnerabilities intentionally omitted — GitHub 422s on POST/PATCH with vulnerabilities:[]
  };
}

export async function syncDraftAdvisory(fetchImpl, token, repo, prNumber, prTitle, flags) {
  const existing = await findExistingDraftAdvisory(fetchImpl, token, repo, prNumber);
  const payload = buildAdvisoryPayload(prNumber, prTitle, flags);

  if (existing) {
    const advisoryId = existing.ghsa_id ?? existing.id;
    if (!advisoryId) {
      throw new Error(`Existing advisory for PR #${prNumber} is missing both ghsa_id and id.`);
    }

    // Omit vulnerabilities on PATCH — GitHub 422s if you try to set it to []
    // on an advisory that already has vulnerabilities recorded.
    const { vulnerabilities: _v, ...patchPayload } = payload;
    try {
      return await fetchImpl(`/repos/${repo}/security-advisories/${advisoryId}`, token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchPayload),
      });
    } catch (err) {
      // 422 on advisory update is non-fatal — the advisory already exists and
      // captures the security flag; swallow so the check-run still gets posted.
      if (err.message && err.message.includes('422')) {
        console.warn(`[security] existing draft advisory ${advisoryId} could not be updated due to GitHub validation; continuing so the PR check can complete.`);
        return null;
      }
      throw err;
    }
  }

  return fetchImpl(`/repos/${repo}/security-advisories`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function findExistingDraftAdvisory(fetchImpl, token, repo, prNumber) {
  const prMarker = `PR #${prNumber}`;

  for (let page = 1; ; page += 1) {
    const advisories = await fetchImpl(
      `/repos/${repo}/security-advisories?state=draft&per_page=100&page=${page}`,
      token,
    );

    if (!Array.isArray(advisories) || advisories.length === 0) return null;

    const existing = advisories.find(advisory =>
      typeof advisory?.summary === 'string' && advisory.summary.includes(prMarker)
    );
    if (existing) return existing;

    if (advisories.length < 100) return null;
  }
}

export async function postSecurityCheckRun(fetchImpl, token, repo, headSha, hasFlags) {
  await fetchImpl(`/repos/${repo}/check-runs`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hasFlags ? {
      name: 'security-review',
      head_sha: headSha,
      status: 'in_progress',
      output: {
        title: 'Security Review Pending',
        summary: 'This PR has been flagged for manual security review by a maintainer. No action needed from you.',
      },
    } : {
      name: 'security-review',
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      output: {
        title: 'Security Review Passed',
        summary: 'No security concerns detected.',
      },
    }),
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { GH_TOKEN, GH_REPO, PR_NUMBER } = process.env;

  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER) {
    console.error('ERROR: GH_TOKEN, GH_REPO, PR_NUMBER required');
    process.exit(1);
  }

  // Sanitize inputs before use in URL construction (prevents SSRF)
  const prNumber = parseInt(PR_NUMBER, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('ERROR: PR_NUMBER must be a positive integer');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    console.error('ERROR: GH_REPO must be in owner/repo format');
    process.exit(1);
  }

  // Validate SENSITIVE_PATHS — fails loudly if any have been refactored away on the PR base branch
  const stalePaths = await validateSensitivePaths(GH_TOKEN, GH_REPO, prNumber);
  if (stalePaths.length > 0) {
    console.error('ERROR: Stale sensitive paths in check-pr-security.mjs:');
    for (const p of stalePaths) console.error(`  - ${p}`);
    console.error('');
    console.error('These paths no longer exist on the PR base branch. The security gate will silently produce no signal for them.');
    console.error('Update SENSITIVE_PATHS in check-pr-security.mjs to reflect the current code structure.');
    process.exit(1);
  }

  const [pr, files] = await Promise.all([
    ghFetch(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN),
    fetchAllPullRequestFiles(ghFetch, GH_REPO, prNumber, GH_TOKEN),
  ]);

  const allFlags = [
    ...scanSecrets(files),
    ...scanCITampering(files),
    ...scanBuildScripts(files),
    ...scanSupplyChain(files),
    ...scanTestPatterns(files),
    ...scanSensitivePaths(files),
  ];

  if (allFlags.length > 0) {
    console.error(`[security] ${allFlags.length} flag(s) detected — creating draft advisory and pending check run`);
    await postSecurityCheckRun(ghFetch, GH_TOKEN, GH_REPO, pr.head.sha, true);
    try {
      await syncDraftAdvisory(ghFetch, GH_TOKEN, GH_REPO, prNumber, pr.title, allFlags);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[security] advisory sync failed; leaving pending security-review check for maintainer review: ${message}`);
    }
  } else {
    console.log('[security] all clear');
    await postSecurityCheckRun(ghFetch, GH_TOKEN, GH_REPO, pr.head.sha, false);
  }

  // Always exit 0 — security flags are silent, never block the PR publicly
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
