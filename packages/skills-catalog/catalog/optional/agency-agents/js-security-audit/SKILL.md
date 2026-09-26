---
name: "js-security-audit"
description: "Audit JS/TS projects against NPM Security Guidelines covering project setup, dependency hygiene, CI/CD pipeline, Dependabot, and incident response."
allowed_tools:
  - Read
  - Glob
  - Grep
  - Bash
key: "paperclipai/optional/agency-agents/js-security-audit"
recommendedForRoles:
  - "designer"
  - "security"
tags:
  - "agency-agents"
  - "designer"
  - "security"
  - "audit"
defaultInstall: false
---
# JS Security Audit

Run a 5-area security audit on a JS/TS project (npm, yarn, or pnpm). Produces a pass/fail report per area with file:line references.

## When to Use

- New repo hardening — verify `.npmrc`, lockfiles, 2FA, exact pinning
- Reviewing a PR that adds or upgrades dependencies
- Setting up CI security gates (`npm ci --ignore-scripts`, lockfile-lint, audit gate)
- After news of a supply-chain attack (Axios March 2026, Shai-Hulud, etc.)
- Periodic security review before production deploy

## Process

> See `audit-checklist.md` for the full MUST/SHOULD/SHOULDN'T list.
> See `eslint-security.md` for the SAST ESLint template and rules table.
> See `incident-playbook.md` for the 5-step compromised-dependency response.
> See `package-manager.md` for npm/yarn/pnpm command equivalents and tooling.

Detect package manager first by checking which lockfile exists: `package-lock.json` (npm), `yarn.lock` (yarn), `pnpm-lock.yaml` (pnpm). Use the matching commands from `package-manager.md`.

### 1. Project Setup
Check `.npmrc`, lockfile presence, version pinning, `.gitignore`, scoped packages.

### 2. Dependency Hygiene
Run audit, scan lockfile diff for unexpected packages, check for `latest` tags and trivial deps.

### 3. CI/CD Pipeline
Verify `npm ci` over `npm install`, `--ignore-scripts` with selective rebuild allowlist, audit gate, lockfile-lint, SHA-pinned actions, SBOM, ESLint security config.

### 4. Dependabot
Check `.github/dependabot.yml`, alert routing, P1 SLA on critical/high, grouping config.

### 5. Incident Response Readiness
Verify the team has a documented playbook, IOC monitoring, credential-rotation runbook.

## Interaction Style

- Detects the package manager from the lockfile, doesn't assume npm
- Flags critical findings (compromised packages, missing audit gate, secrets in repo) before warnings
- Every finding cites a file path or config key
- Every finding has a remediation snippet — not just "fix it"
- Distinguishes MUST (blocks merge) from SHOULD (next sprint) from SHOULDN'T (anti-pattern)

## Rules

- **Critical** — secrets in repo, missing lockfile, `latest` tag in production deps, no `npm audit` gate in CI, missing 2FA on publishers
- **Warning** — missing `.npmrc` hardening, no Dependabot config, no SBOM generation, ESLint security config missing
- **Info** — no `npq` pre-install vetting, no Socket.dev/Snyk integration

## Gotchas

- **AI-hallucinated package names.** Codex (and other LLMs) sometimes suggest packages that don't exist on npm — attackers register these names with malware. Always check `npmjs.com` for the package before installing, especially for less-common names from a chat suggestion.
- **`npm install` vs `npm ci` matters in CI.** `npm install` will rewrite the lockfile if the lockfile and `package.json` disagree, silently pulling new versions. `npm ci` fails the build instead. CI must use `ci`.
- **`--ignore-scripts` blocks legitimate packages too.** `esbuild`, `sharp`, `prisma`, `bcrypt` need their postinstall scripts to download binaries or generate clients. Use `--ignore-scripts` then `npm rebuild <allowlist>` — and document why each package is in the allowlist.
- **Pin GitHub Actions by SHA, not tag.** `actions/checkout@v4` follows the tag, which can be re-pointed to malicious code (it has happened). Use the full 40-char SHA with a comment showing the tag.
- **Lockfile diff is the supply-chain canary.** A PR that adds 200 transitive deps to fix a typo, or changes the resolved URL of an existing package away from `registry.npmjs.org`, is a red flag — investigate before merging.
- **`min-release-age` is npm v11+.** On older npm, mention it as a SHOULD but don't fail the audit.
- **Math.random() in auth code is critical, not warning.** Verification codes, session tokens, password reset tokens generated with `Math.random()` are predictable. Force `crypto.randomInt()`. The Notion guideline calls this out as a real finding from c0x12c codebases.
- **Disabling Dependabot to "reduce noise" is not allowed.** The fix is grouping minor/patch updates, not silencing alerts.

## Recommended Permission Allowlist

The skill needs `Bash` to run `npm audit` and friends. To avoid prompts on every audit, add these to your `~/.Codex/settings.json` (or project `.Codex/settings.json`):

```json
{
  "permissions": {
    "allow": [
      "Bash(npm audit:*)",
      "Bash(npm outdated:*)",
      "Bash(npm explain:*)",
      "Bash(npm list:*)",
      "Bash(npm view:*)",
      "Bash(yarn npm audit:*)",
      "Bash(yarn outdated:*)",
      "Bash(yarn why:*)",
      "Bash(pnpm audit:*)",
      "Bash(pnpm outdated:*)",
      "Bash(pnpm why:*)",
      "Bash(npx lockfile-lint:*)",
      "Bash(npx npq:*)"
    ]
  }
}
```

This keeps the audit commands silent while leaving everything else (write operations, deletes, etc.) gated behind a prompt.

## Output

Produces an audit report:

```
## JS Security Audit: {repo}

### Overall: Pass | Fail

| Area               | Status   | Critical | Warnings | Info |
|--------------------|----------|----------|----------|------|
| Project Setup      | Pass     | 0        | 1        | 0    |
| Dependency Hygiene | Fail     | 1        | 0        | 0    |
| CI/CD Pipeline     | Pass     | 0        | 2        | 1    |
| Dependabot         | Warning  | 0        | 1        | 0    |
| Incident Response  | Info     | 0        | 0        | 1    |

### Critical Findings
- **[Dependency Hygiene]** `lodash` pinned to `latest` in package.json:24
  - Fix: Replace with exact version `"lodash": "4.17.21"`
  - Reason: `latest` resolves at install time, defeating lockfile guarantees

### Warnings
- **[Project Setup]** `.npmrc` missing `ignore-scripts=true`
  - File: `.npmrc:1`
  - Fix: Add `ignore-scripts=true` and use `npm rebuild` for allowlisted packages

### Remediation Priority
1. Fix critical findings before merging
2. Address warnings in next sprint
3. Info items as time permits
```
