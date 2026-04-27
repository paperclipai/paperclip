# Pull Request Checklist for Paperclip

This document captures common issues encountered during PR preparation and CI checks.

## Before Pushing

### Lockfile Management
- **DO NOT commit `pnpm-lock.yaml` in PRs** — CI owns all lockfile updates
  - If you run `pnpm install`, restore the lock file before pushing: `git restore pnpm-lock.yaml`
  - CI will regenerate the lock file during the build
  - Reason: Prevents merge conflicts and ensures deterministic dependency resolution across environments

#### Guard Rails: Pre-Commit Hook
A git pre-commit hook is installed to catch accidental lock file commits:
- **Location:** `.git/hooks/pre-commit`
- **What it does:** Blocks commits if `pnpm-lock.yaml` is staged
- **If triggered:**
  ```
  git restore --staged pnpm-lock.yaml
  git restore pnpm-lock.yaml
  ```
- **For new contributors:** Run `./scripts/setup-hooks.sh` after cloning

### Fork-Specific Packages
- If this is a fork with network constraints or environment-specific adapters (e.g., `crush-local`):
  - **Do not remove** adapter packages without confirming they're not essential
  - Check if any adapters are network-specific or the only ones working in your environment
  - If unsure, ask the team before syncing with upstream or removing packages
  - Reason: Removing essential adapters breaks local development and the system falls back to missing adapters

### Type Definitions for Node.js Modules
- If any package imports Node.js built-ins (e.g., `node:crypto`, `node:fs`, `node:path`, `process`):
  - Ensure `@types/node` is in that package's `devDependencies`
  - Add it if missing: `npm i --save-dev @types/node@^20.0.0`
  - Reason: TypeScript needs type definitions for Node.js globals and built-in modules

### Plugin Manifests
- When updating or restoring plugins, check:
  - Permission scopes are current (e.g., "ui.page.register" not "ui.settingsPage.register")
  - Variable scope: handlers must access module-level state, not closure-local state
  - Config objects used by setup() and handlers must be declared at module scope
  - Reason: Plugin manifest compatibility evolves with SDK; scope issues cause handler failures

## After Running Tests

- Verify `pnpm -r typecheck` passes before claiming the PR is ready
- If targeting CI, ensure all three pass:
  - `pnpm test:run`
  - `pnpm build`
  - `pnpm -r typecheck`

## Related Documentation

- See `AGENTS.md` section 10 for [PR template requirements](.github/PULL_REQUEST_TEMPLATE.md)
- See `AGENTS.md` section 6 for database migration workflow
- See `AGENTS.md` section 7 for verification steps before hand-off
