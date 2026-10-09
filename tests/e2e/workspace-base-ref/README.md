# Workspace starting-branch repair acceptance

This fixture uses a real Git repository with a `master` branch and no `main`
branch. It runs a deterministic process adapter, with no external model calls.
Use a disposable local-trusted instance. The seed changes that instance's
experimental workspace and task-interface flags and creates a test company.

1. Start a disposable Paperclip instance from this checkout. Set a separate
   `PAPERCLIP_HOME` and port. Keep it bound to loopback in `local_trusted` mode.
2. Run `node tests/e2e/workspace-base-ref/seed.mjs http://127.0.0.1:PORT`.
3. Open the returned issue in the browser. Wait for it to become blocked.
4. Confirm the thread says the starting branch is unavailable and shows the
   branch repair card. It must not claim that secrets are missing or offer a
   generic retry of the same broken setting.
5. Click **Use master & retry**. The task must reach **Done**. Its agent comment
   must report that it ran in an isolated worktree at the `origin/master` commit.
6. Reload. Confirm the task remains Done, its task-specific base ref is `master`,
   and its recovery action is resolved. There should be exactly two runs: the
   initial configuration failure and a successful process run.

To test custom input, seed another company and task. Choose **Choose another
branch**. Enter `bad..branch` and submit: the inline error must keep the task
blocked. Change it to `master` and submit. Verify the same durable result.

The worker uses its authenticated run API to obtain its actual workspace and
mark its own task complete. It checks both the fixture file and the Git commit
before doing so. A saved setting or simulated Storybook success alone does not
satisfy this acceptance check.

The component stories are under **Workspace branch recovery**. Their save and
retry callbacks are simulated; use this fixture for the real server journey.
