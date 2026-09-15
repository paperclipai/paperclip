# AI connections through hiring

Paid, opt-in acceptance against a separate loopback `local_trusted` instance. Each
scenario creates its own company and accounts. It never edits an existing company.
Do not start the server with provider API keys: ambient credentials could mask
missing managed-connection bindings.

Start from a fresh worktree with dependencies installed:

```sh
pnpm exec tsx cli/src/index.ts test-drive --data-dir /tmp/paperclip-hiring-qa --no-browser
```

Use the URL printed at startup. Test-drive may choose another available port when
restarted. In a separate shell, export `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, then:

```sh
HIRING_AI_LIVE=1 HIRING_AI_TEST_URL=http://127.0.0.1:3100 \
  pnpm exec playwright test --config tests/hiring-ai-connections/playwright.config.ts --grep 'local:'
```

For both Claude and Codex, the browser creates a task instructing the real parent to
hire one agent of each provider and create a self-assigned subtask. The server's
activity log must attribute both hires to the parent agent. The test verifies the
subtask and a task assigned to the same-provider hire finish under the original
managed account. It then assigns work to the other provider, checks the pending AI
connection card, connects with an API key in the card, and verifies the task resumes
and finishes without sending another message or clicking retry. Completion comments
must be authored by the assigned agent; account and responsible-user attribution
are checked on the successful runs.

Provider calls use real credentials and incur usage. The fixture uses Claude Sonnet
4.6 and Codex GPT-5.4 through their CLI adapters. Provider subscription sign-in is
not automated by this live suite. Integration tests cover subscription inheritance,
credential serialization, and automatic retry after the parent's lease is released.

For representative coverage of the newer native runner, put
`PAPERCLIP_RUNNER_API_TOOLS_ENABLED=true` in the disposable data directory's
`instances/default/.env`, then restart test-drive. Test-drive clears inherited
`PAPERCLIP_*` variables before loading that file. The existing opt-in managed API
tools are how native agents hire. Then use:

```sh
HIRING_AI_LIVE=1 HIRING_AI_RUNNER=native HIRING_AI_TEST_URL=http://127.0.0.1:3100 \
  pnpm exec playwright test --config tests/hiring-ai-connections/playwright.config.ts --grep 'local: native: Codex'
```

This uses native Codex and native ACPX/Claude. It verifies native run persistence,
managed API hiring, native `create_task` delegation, and `paperclip_finish`
completion. Set `HIRING_AI_ENVIRONMENT=daytona` to exercise the same native path
remotely. The default remains legacy CLI adapters; it also asserts that successful
runs stayed on the legacy path. A single native parent scenario exercises both
native worker providers without repeating the full matrix.

## Daytona

Build the plugin and provide `DAYTONA_API_KEY` plus an immutable, qualified runner
image digest. See `tests/runner-e2e/README.md` for the image publication workflow.

```sh
pnpm -C packages/plugins/sandbox-providers/daytona build
HIRING_AI_LIVE=1 HIRING_AI_ENVIRONMENT=daytona \
  HIRING_AI_TEST_URL=http://127.0.0.1:3100 \
  HIRING_AI_DAYTONA_IMAGE=ghcr.io/paperclipai/paperclip-daytona-runner@sha256:YOUR_DIGEST \
  pnpm exec playwright test --config tests/hiring-ai-connections/playwright.config.ts --grep 'daytona:'
```

The same tests install the plugin only in the disposable instance, create a Daytona
environment, and assign it to the parent and both hires. Successful runs must report
that environment. The finalizer cancels remaining active runs in the test company
and deletes the environment and its leases. Task history and encrypted connections
remain in the disposable data directory for inspection.

Native Daytona also requires the controller's remote runner binary and provider
pack. On a Mac, use the Linux artifacts from the same qualified image, not the local
runner binary. The pack must match this checkout's provider pins and profile
digests; a newer image is not automatically compatible. Extract into an empty
destination directory without starting the container:

```sh
mkdir -p /tmp/hiring-native-artifacts
hiring_image_container=$(docker create "$HIRING_AI_DAYTONA_IMAGE" /bin/true)
docker cp "$hiring_image_container:/opt/paperclip-runner/provider-pack" /tmp/hiring-native-artifacts/provider-pack
docker cp "$hiring_image_container:/usr/local/bin/paperclip-runnerd" /tmp/hiring-native-artifacts/paperclip-runnerd
docker rm "$hiring_image_container"
```

Add these settings to the disposable instance's `instances/default/.env`, alongside
the native API-tools flag, and restart test-drive:

```dotenv
PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH=/tmp/hiring-native-artifacts/provider-pack
PAPERCLIP_RUNNER_REMOTE_BINARY_PATH=/tmp/hiring-native-artifacts/paperclip-runnerd
```

Run the Daytona command with `HIRING_AI_RUNNER=native` and
`--grep 'daytona: native: Claude'` for one representative native remote scenario.
If no matching image is available, use the `runnerd-build` and
`provider-pack-build` Docker targets from this checkout, following the runner E2E
workflow's lockfile resolution. Configure both resulting Linux artifacts together;
native startup can stage them over a different image's preinstalled artifacts.
Mixing a newer runner binary with an older provider pack can fail the sidecar
handshake even when the individual provider version pins match.

## Regression and Storybook checks

```sh
pnpm exec vitest run server/src/__tests__/agent-hire-ai-connections.test.ts \
  server/src/services/legacy-execution-recovery.test.ts \
  server/src/services/execution-recovery-attempt.test.ts \
  server/src/services/native-runtime/runner-api.integration.test.ts \
  ui/src/features/connections/ConnectionIntentInteractionBody.test.tsx
pnpm --filter @paperclipai/ui exec storybook dev -p 6010 -c storybook/.storybook --ci --no-open
HIRING_AI_STORYBOOK_URL=http://127.0.0.1:6010 \
  pnpm exec playwright test --config tests/hiring-ai-connections/playwright.config.ts --grep storybook
```

The Storybook checks use the production card and credential components with fixture
API responses. They cover both providers, API/subscription choice, a narrow viewport,
completion, cancellation, and invalid credentials. They do not contact providers.

The Daytona plugin's `file-sync.test.ts` also exercises real GNU tar extraction of
interleaved read-only skill directories. It runs on Linux and on macOS with
`gnu-tar` installed. This guards the macOS-to-Daytona staging failure where directory
permissions were restored before all skill files arrived, while asserting that the
finished directory and files retain their read-only modes.

Screenshots and redacted account/run attribution are written under `test-results/`.
Traces, videos, and automatic failure screenshots are disabled because credential
fields are involved. Each Playwright invocation clears its output directory; use
`--output` to preserve separate local, Daytona, and Storybook evidence. Keep credentials
out of issue descriptions, console output, command-line arguments, and attachments.
