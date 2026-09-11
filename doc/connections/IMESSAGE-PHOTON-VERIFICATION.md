# iMessage Photon verification

Date: 2026-09-11. Branch: `codex/imessage-photon`.
Base inspected: `1c4bcff2b` (`origin/master`).
Status: implementation and targeted acceptance complete; repository verification in progress.
**Not live-provider qualified.**

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
| Workspace typecheck | Passed. |
| Full chat-adapters browser suite | 38 passed, including Photon light/dark/mobile coverage and existing providers. |
| Repository Vitest suite | Full `pnpm test:run` in progress; result recorded before handoff. |
| Build | Full `pnpm build` passed. Final server changes also pass direct TypeScript compilation; post-rebase validation follows. |
| Generated forward migration | Generated through `pnpm db:generate`; `@paperclipai/db check:migrations` passed. Disposable database migrations exercised by integration tests. |
| Native HEIF platform packages | macOS arm64 executed; other published platforms not executed. |

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
