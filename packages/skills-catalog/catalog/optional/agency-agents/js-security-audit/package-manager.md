# Package Manager Quick Reference

> Reference for SKILL.md. Detect the package manager from the lockfile, then use the matching command.

## Detection

| Lockfile | Package Manager |
|----------|----------------|
| `package-lock.json` | npm |
| `yarn.lock` | yarn |
| `pnpm-lock.yaml` | pnpm |

If multiple lockfiles exist, that's a finding — pick one and remove the others.

## Command Equivalents

Detect Yarn version with `yarn --version`. Classic = v1.x, Berry = v2+.

| Action | npm | yarn (Classic v1) | yarn (Berry v2+) | pnpm |
|--------|-----|-------------------|------------------|------|
| Clean install (CI) | `npm ci` | `yarn install --frozen-lockfile` | `yarn install --immutable` | `pnpm install --frozen-lockfile` |
| Ignore scripts | `npm ci --ignore-scripts` | `yarn install --ignore-scripts --frozen-lockfile` | `YARN_ENABLE_SCRIPTS=false yarn install --immutable` | `pnpm install --ignore-scripts` |
| Selective rebuild | `npm rebuild pkg1 pkg2` | `yarn add --force pkg1 pkg2` | `yarn rebuild pkg1 pkg2` | `pnpm rebuild pkg1 pkg2` |
| Audit | `npm audit` | `yarn audit` | `yarn npm audit` | `pnpm audit` |
| Auto-fix audit | `npm audit fix` | N/A | N/A | `pnpm audit --fix` |
| Force version override | `"overrides"` in package.json | `"resolutions"` | `"resolutions"` | `"pnpm.overrides"` |
| Find install lifecycle scripts | `npm query ':attr(scripts, [postinstall])'` | `npx can-i-ignore-scripts` | `npx can-i-ignore-scripts` | `npx can-i-ignore-scripts` |
| Explain why a dep is installed | `npm explain <pkg>` | `yarn why <pkg>` | `yarn why <pkg>` | `pnpm why <pkg>` |
| List outdated | `npm outdated` | `yarn outdated` | `yarn upgrade-interactive` | `pnpm outdated` |

## Override / Resolution Examples

### npm — `package.json`
```json
{
  "overrides": {
    "axios": "1.14.0",
    "some-pkg": {
      "lodash": "4.17.21"
    }
  }
}
```

### yarn — `package.json`
```json
{
  "resolutions": {
    "axios": "1.14.0",
    "**/lodash": "4.17.21"
  }
}
```

### pnpm — `package.json`
```json
{
  "pnpm": {
    "overrides": {
      "axios": "1.14.0"
    }
  }
}
```

## Recommended Tooling

| Tool | Purpose | Integration |
|------|---------|-------------|
| [Socket.dev](https://socket.dev/) | Supply chain attack detection | GitHub PR checks |
| [Snyk](https://snyk.io/) | Vulnerability scanning + monitoring | CI/CD, IDE plugins |
| [lockfile-lint](https://github.com/lirantal/lockfile-lint) | Lockfile integrity validation | Pre-commit, CI |
| [gitleaks](https://github.com/gitleaks/gitleaks) | Secret detection in git history | Pre-commit hook |
| [npq](https://github.com/lirantal/npq) | Pre-install package vetting | CLI wrapper |
| [@cyclonedx/cyclonedx-npm](https://github.com/CycloneDX/cyclonedx-node-npm) | SBOM generation | CI step |
