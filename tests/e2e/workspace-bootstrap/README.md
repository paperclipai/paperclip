# Workspace bootstrap recovery acceptance

This opt-in suite uses a disposable loopback instance, real Git repositories,
the real Git scan scheduler, durable retries, and the task UI. A deterministic
process adapter verifies the prepared files and completes its task through the
run-scoped API. It makes no model calls. The test Git executable injects a real
timeout only when the test explicitly arms a marker inside its repository.

From a development worktree, start the foreground instance:

```sh
BOOTSTRAP_FIXTURE_KEY=not-a-provider-key \
PATH="$PWD/tests/e2e/workspace-bootstrap/bin:$PATH" \
NODE_ENV=test \
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts test-drive \
  --harness codex --api-key-env BOOTSTRAP_FIXTURE_KEY \
  --company-name 'Workspace Recovery QA' --no-browser
```

Set `BOOTSTRAP_REAL_GIT` to the absolute Git executable if it is not
`/usr/bin/git`. Do not point this fixture at a normal development or production
instance. The seeder checks the loopback host, trusted-local mode, and company
name. It does not create tasks; each test creates its task through the UI.

Use the ready URL printed by test-drive:

```sh
WORKSPACE_BOOTSTRAP_TEST_URL=http://127.0.0.1:3100 \
pnpm exec playwright test --config tests/e2e/workspace-bootstrap/playwright.config.ts
```

The tests prove that one timeout schedules a retry and completes without manual
Retry, that persistent timeouts stop after three total runs, and that the final
state survives reload. Source edits remain intact and ignored private files are
not copied. Screenshots and failure traces go to `test-results/workspace-bootstrap`.
Stop test-drive with Ctrl-C. Its disposable data directory remains for inspection.
