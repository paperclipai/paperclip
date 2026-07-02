# BizCursor dual-adapter integration (`opencode_local` + `cursor_cloud`)

Fork: [QuadriniL/paperclip](https://github.com/QuadriniL/paperclip)

This document tracks BizCursor-specific Paperclip improvements for environments that use **only**:

- **`opencode_local`** — CEO, ops, research (local OpenCode CLI)
- **`cursor_cloud`** — Dev implementation (Cursor Cloud Agents API)

## Included in this fork

| Change | Source | Status |
|--------|--------|--------|
| Chat-mode wake (`mode: "chat"`, BizCursor session) | Fork `bizcursor/session-payload` | On `master` |
| OpenCode context pack / think variant | Fork patches | On `master` |
| Omit `PAPERCLIP_WAKE_PAYLOAD_JSON` from cloud envVars | BizCursor spec 2026-07-01 | On `master` (#1) |
| `clampEnvVarsForCloud()` 4096-byte safety | BizCursor spec | On `master` (#1) |
| Post-run Cursor usage API → cost-events tokens | BizCursor spec | On `master` (#1) |
| Drop unreachable Paperclip API callback in cloud | Upstream [#8546](https://github.com/paperclipai/paperclip/pull/8546) | Branch `bizcursor/dual-adapter-integration` |
| Phantom success detection (no git evidence) | Upstream [#8100](https://github.com/paperclipai/paperclip/pull/8100) | Branch `bizcursor/dual-adapter-integration` |

## Deferred (follow-up)

| Change | Source | Why deferred |
|--------|--------|--------------|
| Billing-limit non-retryable + session reset on re-check | [#8835](https://github.com/paperclipai/paperclip/pull/8835) | Heartbeat merge conflict with fork patches; apply after upstream rebase |
| `costUsd` pricing fallback | [#333](https://github.com/paperclipai/paperclip/issues/333) | No pricing catalog entry for Cursor models yet |
| Upstream full rebase | — | Fork ~177 commits behind `paperclipai/master` |
| `cursor_cloud` chat-mode | BizCursor spec v2 | Issue-centric Dev path is sufficient today |

## Smoke tests after deploy

See BizCursor spec: `docs/superpowers/specs/2026-07-01-paperclip-cursor-cloud-fixes-spec.md` §7 (ST-CC-01–07).

## References

- [Cursor Cloud API envVars limits](https://cursor.com/docs/cloud-agent/api/endpoints)
- [Paperclip cursor_cloud adapter PR #5664](https://github.com/paperclipai/paperclip/pull/5664)
