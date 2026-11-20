# FORK_OWNED.md

Files and paths where `redesignhealth/paperclip` carries patches that upstream
`paperclipai/paperclip` does not have. The upstream-sync pipeline
(`tools/upstream-sync/`, see `doc/UPSTREAM-SYNC.md`) reads this file:

- An upstream commit that touches any path below is flagged `fork_owned_hits` in the
  ledger. In P1+ that forces the conflict path (stronger model + Argus review) even if the
  cherry-pick applies cleanly, so fork patches are not silently overwritten.
- Drizzle migrations and schema (`packages/db/src/migrations/`, `packages/db/src/schema/`)
  are always flagged separately, because migration numbering collides with the fork's
  migrations (0371-0378 and onward).

## Format (machine-read)

One bullet per entry. The first backticked token on the bullet is the pattern.
`path/file.ts` is an exact file, `path/dir/` is everything under it, `*` does not cross
`/`, `**` does. Only bullets after the `fork-owned:start` marker below are read. Seeded from the
fork delta against upstream `898144f4b` (catch-up #191). Add a bullet in the same PR as
any new fork patch; remove one when the patch is upstreamed.

<!-- fork-owned:start -->

## Ramp Router (TECH-7895, TECH-7959)

- `packages/adapters/hermes/` Hermes adapter: Router launcher, readiness, create defaults
- `server/src/adapters/hermes-provider-models.ts`
- `server/src/services/hermes-create-defaults.ts`
- `server/src/services/platform-default-router-reconcile.ts`
- `server/src/secrets/platform-default-router-key.ts`
- `server/src/secrets/platform-default-openai-key.ts`
- `server/src/bootstrap-platform-default-key.ts`
- `ui/src/components/new-agent/NewAgentSetup.tsx`
- `ui/src/lib/agent-setup-fields.ts`
- `ui/src/pages/test-support/hermes-create-preflight.ts`

## Shared skills (TECH-9129)

- `server/src/services/shared-skills-source.ts`
- `server/src/secrets/shared-skills-token.ts`
- `server/src/services/shared-skill-defaults.ts`

## Claude Code memory hooks

- `docker/claude/` managed settings (memory hooks; Claude auto memory off, TECH-8749) and the memory hook baked into the image
- `docker/codex/` managed Codex config that registers the same hook

## Hermes defaults and runtime

- `docker/hermes/`
- `packages/paperclip-runner/acpx-profiles.json`
- `packages/paperclip-runner/src/drivers/acpx/`
- `packages/paperclip-runner/generated/`
- `server/src/services/heartbeat/runtime-memory.ts`
- `server/src/services/default-mcp-*.ts`
- `server/src/services/default-agent-profile-routine.ts`
- `server/src/services/default-kb-ingest-routine.ts`
- `server/src/secrets/default-mcp-template-scope.ts`
- `packages/shared/src/default-mcp-template-env.ts`
- `packages/shared/src/memory-agent-guidance.ts`
- `packages/plugins/plugin-rh-agent-memory/`

## Gateway and tool-grant fixes

- `server/src/services/tool-gateway.ts`
- `server/src/routes/tool-gateway.ts`
- `server/src/services/tool-access.ts`
- `server/src/services/tool-access-policy.ts`
- `server/src/routes/tool-access.ts`
- `server/src/services/tool-profile-*.ts`
- `server/src/services/connection-intents.ts`
- `server/src/routes/connection-intents.ts`
- `server/src/services/connectors/slack-catalog.ts`
- `server/src/services/native-runtime/assigned-mcp-tools.ts`
- `packages/shared/src/types/tool-access.ts`
- `packages/shared/src/app-definitions/rh-scheduler-mcp.json`
- `packages/adapters/hermes/src/gateway/`

## Sandbox credential limits (TECH-8988)

- `server/src/runtime-tools-token.ts` GitHub broker token cap for remote targets
- `server/src/services/heartbeat/runtime-execution.ts` agent identity withheld from remote targets
- `server/src/services/heartbeat.ts` broker token capped for remote targets

## Sandbox file bridge waits in the pod (TECH-9007)

- `packages/adapter-utils/src/sandbox-callback-bridge.ts` blocking queue wait instead of a 100 ms host poll
- `packages/adapter-utils/src/sandbox-run-log-stream.ts` run-log tail waits for new output
- `packages/adapter-utils/src/execution-target.ts` blocking wait enabled for Kubernetes only (TECH-9007 hunk)
- `packages/adapter-utils/src/sandbox-callback-bridge-idle-wait.test.ts`
- `doc/plans/2026-11-18-sandbox-bridge-idle-wait.md`

## Fewer Kubernetes sandbox setup execs (TECH-8174)

- `packages/plugins/sandbox-providers/kubernetes/src/file-sync.ts` post-upload extract runs in the upload exec
- `packages/adapter-utils/src/sandbox-callback-bridge.ts` bridge start and readiness in one exec; worker mkdir skippable (TECH-8174 hunks)
- `packages/adapter-utils/src/execution-target.ts` start fold and mkdir skip enabled for Kubernetes only (TECH-8174 hunk)
- `packages/adapter-utils/src/sandbox-bridge-start-fold.test.ts`
- `packages/adapters/hermes/src/server/execute-sandbox.prompt-staging.test.ts`

## Server-wide sandbox run limit (TECH-9015)

- `server/src/services/heartbeat/sandbox-run-slots.ts` server-wide limit on concurrent sandbox runs; runs over it wait in the queue
- `server/src/services/heartbeat/sandbox-run-slots.test.ts`
- `server/src/services/heartbeat/queue.ts` sandbox slot gate before claiming a queued run (TECH-9015 hunks)
- `server/src/services/heartbeat.ts` waiters promoted when a run ends (TECH-9015 hunk)

## Slack file text extraction (TECH-8958)

- `server/src/services/connectors/slack-file-content.ts`
- `server/src/services/connectors/slack-file-content.test.ts`
- `server/src/services/connectors/slack.ts`
- `server/src/services/fixtures/slack-files.ts`
- `packages/shared/src/slack-tools.ts`
- `packages/shared/src/slack-tools.test.ts`

## Owner handoff and ownership (TECH-7952, comms ownership)

- `server/src/services/access.ts`
- `server/src/routes/access.ts`
- `server/src/services/comms-*.ts`
- `server/src/services/comms-board-provisioner-client.ts`
- `server/src/services/arcana-*.ts`
- `packages/db/src/schema/invites.ts`
- `packages/shared/src/comms-board-provisioner-env.ts`
- `packages/shared/src/arcana-provisioner-env.ts`
- `ui/src/pages/InviteLanding.tsx`
- `ui/src/components/access/InvitesSection.tsx`

## Slack file reading (TECH-8958)

- `server/src/services/connectors/slack-document.ts`

## SSO, tenant isolation and company memory

- `server/src/auth/better-auth.ts`
- `server/src/middleware/tenant-context.ts`
- `server/src/services/scram-verifier.ts`
- `server/src/services/company-memory-*.ts`
- `server/src/services/company-memory-upgrade/`
- `server/src/services/company-visibility-backfill.ts`
- `packages/db/src/company-scope.ts`
- `packages/db/src/rls.ts`
- `packages/db/src/rls-boot-check.ts`
- `packages/db/src/render-rls-migration.ts`
- `packages/db/src/tenant-context.ts`
- `packages/db/src/schema/company_memory_upgrades.ts`
- `ui/src/pages/InstanceSsoSettings.tsx`
- `ui/src/components/auth/`
- `docker/sso/`
- `docker/docker-compose.sso.yml`

## CI, review gate and docs owned by the fork

- `.github/workflows/auto-approve.yml`
- `.github/workflows/auto-approve-job.yml`
- `.github/workflows/gate-tests.yml`
- `.github/workflows/pr-trusted.yml`
- `.github/workflows/ci-routing.yml`
- `.github/rulesets/`
- `.github/scripts/`
- `docs/merge-policy.md`
- `doc/TEST-AND-DEPLOY-RUNBOOK.md`
- `doc/HERMES-RC-GATE-RUNBOOK.md`
- `doc/HOSTED-AGENT-CONTAINMENT.md`
- `doc/COMPANY-MEMORY-RUNBOOK.md`
- `doc/SSO.md`
- `FORK_OWNED.md`
- `tools/upstream-sync/`
- `doc/UPSTREAM-SYNC.md`
