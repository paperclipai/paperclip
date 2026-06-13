# RFC: Telegram group chat integration (task trees ↔ forum topics)

Status: **draft, pre-review** · Authors: Paperclip CTO (Automation Studio) · Last updated: 2026-04-19

## Summary

Add a first-class Paperclip integration that mirrors an entire issue branch (one root issue + its whole descendant tree) into a single Telegram **forum topic** inside a team chat. Outbound: platform events (comment/status/assignee) are posted to the matching topic. Inbound: messages in the topic become comments on the relevant issue. State and bindings live on the Paperclip platform, not in per-agent plugins or in an external bridge.

This is the first package under a new workspace category `packages/integrations/*`, distinct from `packages/adapters/*` (agent runtimes) and `packages/plugins/*` (per-agent plugin SDK surface). Future Slack/Discord/Linear-sync integrations belong here.

## Motivation

- Teams want a live, human-readable feed of an issue tree in Telegram without logging into the Paperclip UI.
- Existing surfaces do not fit:
  - `paperclip-telegram-bridge` is 1:1 client↔consultant, with scrub that strips internal ids — the opposite of a team chat where ticket ids are desirable.
  - `plugin:telegram:telegram` is a per-agent reply channel with no group-admin primitives (`createForumTopic`, `editForumTopic`, `closeForumTopic`) and no long-lived state store.
- Forum topics are a natural 1:1 match for an issue branch — a persistent, titled thread with lifecycle (open/closed, rename, icon).

## Non-goals (for v0.1 MVP)

- Bi-directional slash-command DSL in the topic (`/status`, `/assign`, `/close`). Tracked for v0.2.
- Multi-chat routing per project. v0.1 supports one binding per scope; v0.3 adds richer routing.
- Paperclip-side UI for editing bindings beyond the approval flow. CLI + approval form only in v0.1.

## Mapping model

**Binding scope** is one of: `companyId`, `projectId`, or `goalId`. Each binding has exactly one Telegram `chat_id`.

**Branch = root issue + entire descendant tree.** One forum topic per root issue. Child issues (any depth) log into the same topic, prefixed with their identifier:

```
AUT-126 · status: in_progress (by Danil)
AUT-127 · [new issue] Wire outbound poster · priority: medium
AUT-127 · comment by @claudecoder: draft pushed, see diff
AUT-128 · [new issue] Wire inbound webhook · parent: AUT-126
AUT-126 · status: done
```

Rationale: per-issue topics overflow the forum in active projects and destroy the sense of a "branch." Root-topic keeps the forum readable at the cost of a flat log per branch — an explicit trade the RFC accepts.

The "root" for any issue is computed by walking `parentId` up until `null`. If the root does not yet have a topic, one is created on first relevant event.

## Surface area

### Binding API (platform-side, new)

```ts
type TopicStrategy = "root-issue-with-subtree"; // v0.1 only

interface TelegramGroupBinding {
  id: string;
  companyId: string;
  scope: { kind: "company" } | { kind: "project"; projectId: string } | { kind: "goal"; goalId: string };
  chatId: number;
  botTokenRef: string; // secret-manager reference, never the literal token
  adminUserIds: string[]; // Paperclip users allowed to manage the binding
  topicStrategy: TopicStrategy;
  redactInternalIds: boolean; // default false; true for mixed/external chats
  status: "pending" | "active" | "error";
  createdAt: string;
  createdByUserId: string;
}
```

Mutations go through a board approval (`type: "request_board_approval"`, payload includes `chatId` + scope + bot-presence check results). Agents cannot create bindings directly.

### Topic state store

```ts
interface TopicBinding {
  issueId: string; // root issue
  chatId: number;
  messageThreadId: number; // Telegram forum topic id
  createdAt: string;
  lastSyncedAt: string;
  statusSnapshot: IssueStatus; // last mirrored status, for drift detection
}
```

Indexed on `(chat_id, message_thread_id)` for inbound lookup and `(issue_id)` for outbound.

### Outbound pipeline

Subscribes to platform issue events:

- `issue.created` → if in-scope, walk to root; ensure topic; post `"<identifier> · [new issue] <title> · priority: <p>"`.
- `issue.status_changed` → post `"<identifier> · status: <new> (by <actor>)"`; on root, also `editForumTopic` (icon = status color, name = identifier + title); on `done`/`cancelled`, optionally `closeForumTopic` (binding flag).
- `issue.comment_created` → post `"<identifier> · comment by <actor>: <body>"` with a scrub pass if `redactInternalIds` is true.
- `issue.assignee_changed` → post `"<identifier> · assigned to <name>"`.

Rate limits: TG bot API is 30 msg/s globally and ~20/min per chat. Outbound poster uses per-chat batching with exponential backoff on `429`.

### Inbound pipeline

Telegram webhook (Paperclip-hosted endpoint; long-poll is an alternative for self-hosted). Each update with `message_thread_id`:

1. Lookup `(chat_id, message_thread_id)` → root `issueId`.
2. Map `from.id` to a Paperclip user via an opt-in linking table (`telegram_user_links`). Unlinked posters render as `[telegram:@username]` author label.
3. `POST /api/issues/{issueId}/comments` with the message text.

Out of scope v0.1: replies on a specific child issue (`/assign AUT-128 ...`). v0.1 treats the whole branch as one stream; routing DSL is v0.2.

## Security & privacy

- Bot token is stored via the platform secret manager, never in config files.
- Bot must be a forum admin with `can_manage_topics`; otherwise binding is rejected at approval time and the approval record carries the failure reason.
- Internal ids leak on purpose (team chat); for mixed/external chats, `redactInternalIds: true` routes every outbound through a scrub step adapted from `paperclip-telegram-bridge/src/outbound/scrub.ts`.
- The webhook endpoint verifies `X-Telegram-Bot-Api-Secret-Token` per binding.

## Testing

- Unit: topic-name formatter, status→icon map, scrub integration.
- Integration: mocked Bot API for the full loop (root create → topic create → child create → comment → inbound echo → comment-on-issue).
- Smoke: `scripts/smoke-telegram-group.ts` against a real throwaway chat behind a feature flag.

## Estimate & phasing

| Phase | Scope | Effort |
|------|-------|-------|
| v0.1 MVP | Bindings API + approval, state store, outbound comment/status, inbound webhook → comment | ~1.5 weeks, 1 eng |
| v0.2 | Topic lifecycle (`editForumTopic`/`closeForumTopic`), in-topic command DSL, per-child routing | +1 week |
| v0.3 | Production: permissions UX, multi-chat routing, metrics/traces, linking flow for Telegram users | +1–1.5 weeks |

## Open questions for platform reviewers

1. Is `packages/integrations/*` the right home, or do you prefer `packages/adapters/*` extended with a non-agent sub-category?
2. Platform event bus: what's the stable subscription API for `issue.*` events that external-but-in-tree packages should use? (Today the MCP server has direct DB access; an integration package should not.)
3. Secret-manager integration: is there a shared helper for `botTokenRef` resolution, or should this RFC define one?
4. Who owns webhook hosting when Paperclip is self-hosted behind NAT — do we recommend bundling a public relay, or leave it to the operator?

## References

- Parent internal issue: AUT-126 (CTO tracking of this PR).
- Original proposal: AUT-124 plan document.
- Board approval in principle: AUT approval a751ae9b-2463-4335-abf9-3fccb4b05a44.
