# Trusted reporting dependencies

`report` and `publish_history` install only this private package. Its committed
npm lock binds every registry tarball by version and SHA512 integrity. The jobs
use `npm ci --ignore-scripts` and never regenerate a lock or install the root
workspace. The target checkout and target lock artifact do not participate.

The four direct dependencies cover the existing reporting import graph:
Playwright merges reports and renders the offline public summary; tsx loads
trusted TypeScript; zod and ajv support the trusted catalog's schema imports.
The workflow explicitly links only the trusted checkout's adapter-utils source.
Missing future dependencies fail rather than falling back to a workspace install.
Chromium is installed before OIDC credential exchange, and its summary-rendering
process already receives a restricted environment without publication secrets.

Dependency updates are source changes for review. To update this lock locally:

```sh
npm install --prefix tests/runner-e2e/reporting-runtime --package-lock-only --ignore-scripts --no-audit --no-fund
```

Review every changed package version/integrity, then run the workflow boundary
tests and the report/publisher smoke with local evidence and a fake AWS CLI.
Never run that update command in the reporting workflow. Do not edit the
CI-owned root pnpm lock for this package.

The exact `fast-uri` override uses the patched 3.1.6 line for the URI parsing
advisories, including [GHSA-f65p-4m7j-42xc](https://github.com/fastify/fast-uri/security/advisories/GHSA-f65p-4m7j-42xc).
Do not inherit an older vulnerable version solely because it appears in the
workspace lock. The standalone runtime follows the repository Node engine policy.
