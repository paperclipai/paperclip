# Verify the published npm experience

Use this route for “can a user install and run this package?” Source startup,
workspace links, `pnpm build`, and local tarballs do not answer that question.

## Resolve the exact artifact

Read [.github/workflows/release.yml](../../../../.github/workflows/release.yml)
for publication behavior. Canary publication follows verified pushes to `master`;
an arbitrary feature-branch SHA need not have a published canary. Publication can
fail or still be running, so prove registry availability before claiming coverage.

Resolve the requested channel once against the public registry:

```sh
npm view paperclipai@canary version --registry=https://registry.npmjs.org
npm view paperclipai@latest version --registry=https://registry.npmjs.org
```

Use the one requested by the task: `canary` for prerelease verification, `latest`
for stable production npm verification, or an explicit version. Record resolved
version, registry, dist integrity, and source provenance from release metadata,
workflow, and tags. Pin that version for all later commands. If testing a SHA,
confirm the package maps to it; never substitute the current canary silently.
Missing publication is a blocked check, not a reason to publish during verification.

## Install like a new user

Use a disposable directory outside the checkout and fresh npm cache,
instance/config, and user-config paths. Use an isolated OS user/container when
proving absence of all pre-existing user state. Inspect inherited routing and
registry overrides without exposing secrets. Avoid workspace dependencies, local
`file:` packages, preinstalled Paperclip binaries, and cached `npx` installs.

Run the documented end-user entry point with the pinned package, for example
`npx --yes --registry=https://registry.npmjs.org paperclipai@<exact-version>`.
Read that version's `--help` before selecting `onboard`, `install`, or service
flags. For a foreground disposable check use `onboard --yes --bind loopback
--no-install-service --run --data-dir <fresh-directory>` when supported by that
version; keep ordinary interactive onboarding when that is the journey requested.
A managed CLI/service installation is separate from an ephemeral `npx` launch;
test it explicitly if requested.

Prove each relevant stage separately: registry download/install, CLI execution,
server readiness, visible onboarding, saved company/setup state, restart/reload,
and a first agent task when authorized. Successful `--version` alone does not
prove a usable install. For upgrades, first create state with the previous exact
version, then install the target against that same disposable data and verify
state survives; report this separately from a fresh install.

## Existing automation and its limits

The repo has a published-package onboarding suite:

```sh
PAPERCLIPAI_VERSION=<exact-published-canary-version> pnpm test:canary-onboarding-smoke
```

Read [its configuration](../../../../tests/canary-onboarding/playwright.config.ts)
and [launcher](../../../../tests/canary-onboarding/start-published-canary.mjs)
before running. It installs the published package into isolated temporary state,
uses a fresh npm cache and loopback server, and retains failure diagnostics.
It uses checkout Playwright tooling to drive a published runtime; record both
revisions. Its name and automated release wiring target canaries. For stable
verification, inspect compatibility with the selected version or use the manual
pinned-package path above; do not relabel a canary result as stable proof.

The Docker release-smoke suite is separate image evidence. Likewise,
`scripts/clean-install-npm.sh` defaults to source, and its published mode uses a
moving version and source-driven uninstall; it does not by itself prove the
whole lifecycle of a specific published version.

Capture OS/architecture, Node/npm versions, exact commands and exit codes,
installed version, serving revision when available, initial data state, screenshots,
logs, and observed outcomes. Redact credentials. Stop owned foreground processes
or uninstall an owned test service with the tested version's supported command;
retain evidence outside disposable data. Never run checkout ownership helpers
with invented metadata to stop a package process.
