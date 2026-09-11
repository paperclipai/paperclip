# iMessage Photon verification

Date: 2026-09-11. Branch: `codex/imessage-photon`.
Base inspected: `1c4bcff2b`; rebased onto `f12b647ae` (`origin/master`).
Implementation checked: `7ada38eb7ef5dff5441f23c02131798b11d57712`.
**Status: experimental implementation; not live-provider qualified.**

[PR #13299](https://github.com/paperclipai/paperclip/pull/13299) carries the current
CI and review results. Greptile reviewed the implementation commit at 5/5 with no
actionable comments. This record distinguishes local evidence from live proof.

## Environment and versions

- Fresh worktree: `imessage-photon`; separate worktree configuration, instance,
  database/storage home, and application port 3109.
- Browser tests use a disposable local-trusted instance on port 3319 with a new
  database and storage home. They mock the provider/control-plane responses.
- Database integration tests use disposable embedded PostgreSQL with real channel,
  identity, task, attachment, publication, and interaction services.
- Advanced SDK 2.1.0; grpc-js 1.14.4; nice-grpc 2.1.17; nice-grpc-common 2.0.4;
  heif2jpeg 0.1.6. Local converter execution: macOS arm64.
- The synthetic HEIC fixture is generated from a solid-color 16×16 image. It has
  no personal photo content and does not qualify real iPhone HEIC/Live Photos.
- Production credentials, line tokens, phone numbers, and participant identifiers
  are absent from this record. Test numbers/IDs in fixtures are synthetic.

The primary-instance seed attempt encountered existing source schema drift
(`tool_connections_transport_check` missing), so the isolated worktree uses a clean
instance. The primary database was not modified. Several test starts also reached
macOS's 32-segment System V shared-memory limit. Only unattached IPC from this task's
exited browser-test databases was eligible for cleanup; running instances were not
stopped or altered.

## Deterministic acceptance evidence

`server/src/__tests__/photon/photon.test.ts` exercises Basic Cloud authentication,
token redaction, dedicated/shared/missing allocation, immutable line identity,
Unicode multipart publication, receipt recovery, unknown sends and explicit retry,
upload receipt reuse, quota classification, per-part authorization, contiguous
checkpoint recovery, ignored event frames, cutoff history, lease loss, real local
gRPC framing/authentication, scoped state, duplicate-title poll IDs, poll creation
before a local crash, answer parsing, source ownership, image bounds, and actual
synthetic HEIC conversion.

`server/src/__tests__/photon/channel.integration.test.ts` composes the real channel
service with the Photon adapter and synthetic provider responses. It proves the
fresh linked-message/task/agent-publication setup requirement, restored DM reply,
echo filtering, identity reservation, explicit group enablement, authorized poll
resolution, per-person answer drafts, rejection reasons, exactly one canonical
continuation record, delayed HEIC retry after restart, attachment provenance,
quoted context, task generations, stale controls, retained pending input through
pause, group removal, and a native continuation proof for a second group person.
The checkpoint takeover test verifies the database lease and checkpoint update
share one transaction.

The native continuation test caught a JSON key-order mismatch after JSONB storage.
Both the recorded answer digest and reconstructed proof now use the existing
canonical hash. This is a native authorization composition test, not evidence of
a live model turn through Photon.

The Photon browser cases in `tests/e2e/chat-adapters-ui.spec.ts` cover catalog
discovery, multiple-line selection, password input, keyboard selection, vaulted
credential payload shape, setup completion, group enablement, light/dark themes,
mobile navigation/layout, and pause/resume. The surrounding suite covers existing
Slack, Discord, GitHub, Teams, and Telegram surfaces.

| Check | Result |
| --- | --- |
| Photon targeted tests | 30 passed, including checkpoint takeover, Live Photo companion retention, and native continuation authorization. |
| Token gates | Passed. All four gates clean. |
| Workspace typecheck | Full `pnpm -r typecheck` passed before and after rebase. |
| Full chat-adapters browser suite | 38 passed, including Photon light/dark/mobile coverage and existing providers. |
| Post-rebase channel/native checks | 87 passed across Photon, explicit native continuation, and chat-control admission retry. |
| Native session resume | 37 passed after building the required local fake-provider binary. |
| UI Vitest project | 6,008 passed across 582 files after rebase. |
| Shared catalog project | 727 passed, including exact catalog and branding coverage. |
| Repository Vitest suite | `pnpm test:run` exercised the general-server suite; initial catalog/fixture failures were corrected and focused reruns pass. Full gate status and route-suite results are recorded in the linked PR. |
| Build | Full `pnpm build` passed before and after rebase. |
| Generated forward migration | Generated through `pnpm db:generate`; `@paperclipai/db check:migrations` passed. Disposable database migrations exercised by integration tests. |
| Native HEIF platform packages | macOS arm64 executed; other published platforms not executed. |

### Local test prerequisites

The standard `pnpm test:run` launcher isolates `PAPERCLIP_CONFIG`, `PAPERCLIP_HOME`,
and temporary files. Direct heartbeat/continuation tests must use equivalent
isolation; otherwise the worktree preview configuration suppresses execution.
The actual runner-driver fixture also requires:

```sh
cargo build --manifest-path packages/paperclip-runner/runner/Cargo.toml --bin fake-codex-app-server
```

A run without that binary failed at provider startup; the complete 37-case native
session-resume suite passed after building it. Catalog assertions were updated
for the 42nd visible app, and the focused catalog/Browse/board-gallery tests pass.
Some broad package runs encountered host embedded-Postgres startup limits during
concurrent local development. These startup failures are not provider proof;
inspect the linked PR for the current complete gate results.

## Live qualification still required

No dedicated Photon project/line credentials or approved test participants were
available during implementation. No live messages, polls, uploads, or approvals
were sent. The following matrix must be completed before release readiness.
Record the tested commit, package versions, redacted project/line/chat IDs,
participants, timestamps, and observable results when running it.

| Live case | Status |
| --- | --- |
| Linked DM creates task and receives actual agent response | Not run. |
| Enabled group with two linked people preserves attribution | Not run. |
| Unlinked sender cannot start work | Not run. |
| Inbound/outbound photos and real iPhone HEIC | Not run. |
| Native poll and text answer resume correct interaction | Not run. |
| Approval rejection reason reaches canonical interaction | Not run. |
| Restart preserves DM/group replies and pending questions | Not run. |
| Pause/resume/reconnect/removal enforce authority | Not run. |
| Completed conversation stays idle until fresh input | Not run. |
| Provider ambiguous-send/idempotency behavior | Not run against Photon. |
| HEIF conversion on Linux glibc/Windows and deployment packaging | Not run. Linux musl has no packaged converter. |

Keep this channel behind the existing experimental gate. Mocked tests, synthetic
gRPC, and a visible catalog card do not establish these live results.
