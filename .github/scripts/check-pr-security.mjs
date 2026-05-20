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
  const PKG_RE = /^([+-])\s{2}'(@?[a-z][a-z0-9\-_./@]*)@[^']+'/;

  for (const line of lockfile.patch.split('\n')) {
    const m = line.match(PKG_RE);
    if (!m) continue;
    if (m[1] === '+') added.add(m[2]);
    if (m[1] === '-') removed.add(m[2]);
  }

  const netNew = [...added].filter(p => !removed.has(p));
  return netNew.length ? [{ check: 'supply-chain', packages: netNew }] : [];
}

const TEST_FILE_RE = /\.(test|spec)\.(ts|js|tsx|jsx)$|\/tests?\//;
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
  'server/src/routes/agents/',
  'server/src/lib/assertCompanyAccess',
  'server/src/execution/',
  'server/src/adapters/',
  'packages/markdown/',
  'server/src/routes/imports/',
  'server/src/routes/api/',
  'server/src/skills/',
  'server/src/approval/',
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

async function createAdvisory(token, repo, prNumber, prTitle, flags) {
  const checkNames = [...new Set(flags.map(f => f.check))].join(', ');
  const severity = worstSeverity(flags);

  const description = [
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
  ].join('\n');

  await ghFetch(`/repos/${repo}/security-advisories`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: `🚨 Security flag — PR #${prNumber}: ${checkNames}`,
      description,
      severity,
      vulnerabilities: [],
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

  const [pr, files] = await Promise.all([
    ghFetch(`/repos/${GH_REPO}/pulls/${PR_NUMBER}`, GH_TOKEN),
    ghFetch(`/repos/${GH_REPO}/pulls/${PR_NUMBER}/files?per_page=100`, GH_TOKEN),
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
    console.error(`[security] ${allFlags.length} flag(s) detected — creating draft advisory`);
    await createAdvisory(GH_TOKEN, GH_REPO, PR_NUMBER, pr.title, allFlags);
  } else {
    console.log('[security] all clear');
  }

  // Always exit 0 — security flags are silent, never block the PR publicly
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
