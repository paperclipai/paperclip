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
| Drop unreachable Paperclip API callback in cloud | Upstream [#8546](https://github.com/paperclipai/paperclip/pull/8546) | On `master` (#2) |
| Phantom success detection (no git evidence) | Upstream [#8100](https://github.com/paperclipai/paperclip/pull/8100) | On `master` (#2) |
| Strip JWT secrets from spawned agent env | Upstream [#4734](https://github.com/paperclipai/paperclip/pull/4734) | Branch `bizcursor/upstream-wave-1` (#3) |
| Remove `OPENCODE_DISABLE_PROJECT_CONFIG` | Upstream [#7292](https://github.com/paperclipai/paperclip/pull/7292) | Branch `bizcursor/upstream-wave-1` (#3) |
| JSONC runtime config for OpenCode providers | Upstream [#8075](https://github.com/paperclipai/paperclip/pull/8075) | Branch `bizcursor/upstream-wave-1` (#3) |
| `opencode export` fallback (v1.15.10+) | Upstream [#6766](https://github.com/paperclipai/paperclip/pull/6766) | Branch `bizcursor/upstream-wave-1` (#3) |
| Issue `billing_code` → cost-events | Upstream [#6821](https://github.com/paperclipai/paperclip/pull/6821) | Branch `bizcursor/upstream-wave-1` (#3) — chat-mode billing preserved |
| Active run reaping fix (multi-instance) | Upstream [#8776](https://github.com/paperclipai/paperclip/pull/8776) | Branch `bizcursor/upstream-wave-2` (#4) |
| Fresh session on comment wakes | Upstream [#6650](https://github.com/paperclipai/paperclip/pull/6650) | Branch `bizcursor/upstream-wave-2` (#4) |
| Monitored continuation recovery | Upstream [#8813](https://github.com/paperclipai/paperclip/pull/8813) | Branch `bizcursor/upstream-wave-2` (#4) |
| Billing-limit non-retryable + re-check session reset | Upstream [#8835](https://github.com/paperclipai/paperclip/pull/8835) | Branch `bizcursor/upstream-wave-2` (#4) |
| Dead silent run auto-timeout | Upstream [#8814](https://github.com/paperclipai/paperclip/pull/8814) | Branch `bizcursor/upstream-wave-2` (#4) |

## Deferred (follow-up)

See [UPSTREAM-CHERRY-PICK-BACKLOG.md](./UPSTREAM-CHERRY-PICK-BACKLOG.md) for wave 2 items.

| RF-P2-03 pricing fallback (`costEstimated: true`) | `bizcursor/cursor-cloud-integration` | Implemented |
| Chat-mode `paperclipChatWake` for `cursor_cloud` | `bizcursor/cursor-cloud-integration` | Implemented |
| Run Observer + internal webhook bridge | `bizcursor/cursor-cloud-integration` | Implemented |
| Structured cursor run events (`git.pr_opened`) | `bizcursor/cursor-cloud-integration` | Implemented |

## Smoke tests after deploy

See BizCursor spec: `docs/superpowers/specs/2026-07-01-paperclip-cursor-cloud-fixes-spec.md` §7 (ST-CC-01–08). Run via Paperclip Board API — not BizCursor app.

## References

- [Cursor Cloud API envVars limits](https://cursor.com/docs/cloud-agent/api/endpoints)
- [Paperclip cursor_cloud adapter PR #5664](https://github.com/paperclipai/paperclip/pull/5664)
