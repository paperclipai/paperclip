# JS Security Audit — Full Checklist

> Reference for SKILL.md. Each section split into MUST (critical), SHOULD (warning), SHOULDN'T (anti-pattern).

## 1. Project Setup

### MUST
- [ ] **Exact versions for critical deps** — no `^` or `~` for packages with postinstall scripts (axios, prisma, esbuild, sharp)
  ```json
  { "axios": "1.14.0", "prisma": "6.5.0" }
  ```
- [ ] **Lockfile committed** — `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml` in git, never `.gitignore`d
- [ ] **`.npmrc` hardening present**
  ```
  audit=true
  ignore-scripts=true
  engine-strict=true
  save-exact=true
  ```
- [ ] **`.env` and secrets in `.gitignore`**
  ```
  .env
  .env.*
  *.pem
  *.key
  ```
- [ ] **npm 2FA enabled** for everyone with publish access
  ```bash
  npm profile enable-2fa auth-and-writes
  ```

### SHOULD
- [ ] **Scoped packages** (`@yourorg/pkg-name`) for internal modules — prevents public namespace squatting
- [ ] **`npm doctor`** clean after setup
- [ ] **Lockfile linter in pre-commit**
  ```bash
  npx lockfile-lint --path package-lock.json --type npm \
    --allowed-hosts npm --validate-https
  ```

### SHOULDN'T
- Don't use `latest` tag in dependencies
- Don't store npm tokens in `.bashrc` / `.zshrc` — use `NPM_TOKEN` scoped to CI
- Don't use multiple registries without explicit scope mapping in `.npmrc`

---

## 2. Adding & Updating Dependencies

### MUST
- [ ] **`npm audit` before merge**
  ```bash
  npm audit --audit-level=high
  ```
- [ ] **Lockfile diff reviewed in PRs** — investigate unexpected packages or changed resolved URLs
- [ ] **Transitive deps audited**
  ```bash
  npm explain <suspicious-package>   # shows why it's in your tree
  ```

### SHOULD
- [ ] **Wait 3+ days on new major versions** — most malicious packages are caught within 72 hours
  ```
  # .npmrc (npm v11+)
  min-release-age=3
  ```
- [ ] **Use `npx npq <package>` before first install** — checks typosquatting, vulns, suspicious scripts
- [ ] **Prefer well-maintained alternatives** — check stars, last commit, open issues, maintainer count
- [ ] **Run `npm outdated` weekly** to find stale packages with unpatched CVEs

### SHOULDN'T
- Don't install packages an LLM suggested without verifying on `npmjs.com` — LLMs hallucinate package names
- Don't run `npm install` to update one package — use `npm install <pkg>@<version>` explicitly
- Don't ignore `npm audit` warnings indefinitely — apply overrides or evaluate alternatives
- Don't add deps for trivial functionality (`is-odd`, `left-pad`) — write the 3 lines yourself

---

## 3. CI/CD Pipeline

### MUST
- [ ] **`npm ci --ignore-scripts` (not `npm install`)**
  ```yaml
  - name: Install dependencies
    run: npm ci --ignore-scripts
  ```
- [ ] **Selective rebuild allowlist** for packages that need postinstall
  ```yaml
  - name: Install dependencies
    run: |
      npm ci --ignore-scripts
      npm rebuild esbuild sharp prisma   # approved packages only
  ```
  Document why each package needs rebuild:
  ```yaml
  # esbuild: prebuilt binary download
  # sharp: libvips download
  # prisma: client generation
  ```
- [ ] **`npm audit` as a CI gate**
  ```yaml
  - name: Security audit
    run: npm audit --audit-level=high
  ```
- [ ] **Lockfile integrity validation in CI** — match the variant to the project's lockfile:
  ```yaml
  # npm
  - run: npx lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https
  # yarn
  - run: npx lockfile-lint --path yarn.lock --type yarn --allowed-hosts npm --validate-https
  # pnpm
  - run: npx lockfile-lint --path pnpm-lock.yaml --type pnpm --allowed-hosts npm --validate-https
  ```
- [ ] **No secrets in CI config files** — use GitHub Secrets / GitLab CI Variables

### SHOULD
- [ ] **Socket.dev or Snyk in PR workflow**
  ```yaml
  - uses: socketsecurity/socket-security-action@v1
  # or
  - uses: snyk/actions/node@master
    env:
      SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
  ```
- [ ] **Pin actions by SHA, not tag**
  ```yaml
  # BAD
  - uses: actions/checkout@v4

  # GOOD
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
  ```
- [ ] **SBOM for production builds**
  ```bash
  npx @cyclonedx/cyclonedx-npm --output-file sbom.json
  ```
- [ ] **SAST via dedicated `eslint.security.js`** — see `eslint-security.md`

### SHOULDN'T
- Don't use `npm install` in CI — ignores lockfile constraints
- Don't skip `npm audit` to speed up the pipeline — cache it instead
- Don't use `--no-verify` to bypass git hooks in CI
- Don't allow PRs to merge with critical/high audit findings

---

## 4. GitHub Dependabot

### MUST
- [ ] **Dependabot alerts and security updates enabled** on every repo
  - Settings > Code security > Dependabot — enable "Dependabot alerts" + "Dependabot security updates"
  - Or commit `.github/dependabot.yml`:
  ```yaml
  version: 2
  updates:
    - package-ecosystem: "npm"
      directory: "/"
      schedule:
        interval: "weekly"
        day: "monday"
      open-pull-requests-limit: 10
      reviewers:
        - "your-team-slug"
      labels:
        - "dependencies"
        - "security"
  ```
- [ ] **Dependabot alerts route to security team** — Settings > Code security > Notification recipients
- [ ] **Critical/high Dependabot PRs treated as P1** — review and merge within 48 hours

### SHOULD
- [ ] **Group minor/patch updates** to reduce PR noise
  ```yaml
  groups:
    production-deps:
      dependency-type: "production"
      update-types: ["minor", "patch"]
    dev-deps:
      dependency-type: "development"
      update-types: ["minor", "patch"]
  ```
- [ ] **Enable Dependabot version updates** (not just security) — reduces upgrade debt
- [ ] **Use `@dependabot rebase` / `@dependabot recreate`** on stale PRs instead of closing
- [ ] **Branch protection requires CI on Dependabot PRs**

### SHOULDN'T
- Don't ignore Dependabot PRs — stale alerts create false sense of security
- Don't merge Dependabot PRs without CI passing — bumps can break things
- Don't disable Dependabot to reduce noise — use grouping instead

---

## 5. Incident Response Readiness

### MUST
- [ ] **Documented playbook exists** — see `incident-playbook.md`
- [ ] **Team knows how to detect a compromised version**
  ```bash
  npm list <package> | grep -E "<compromised-version>"
  grep -E "<compromised-version>" package-lock.json
  ```
- [ ] **Credential rotation runbook covers**: npm tokens, SSH keys, AWS/GCP creds, DB passwords, API keys
- [ ] **Override mechanism documented** for forcing transitive dep versions
  ```json
  { "overrides": { "<package>": "<safe-version>" } }
  ```

### SHOULD
- [ ] **IOC monitoring** — known C2 domains, malware artifact paths blocklisted
- [ ] **Audit which CI runners/dev machines installed during exposure window**
- [ ] **Post-incident: package added to pinning policy + rebuild allowlist documentation updated**

### SHOULDN'T
- Don't rely on `npm audit` alone for supply-chain detection — it's CVE-based, lags real attacks
- Don't restore from `node_modules` cache after an incident — `rm -rf node_modules` and reinstall from a known-good lockfile
