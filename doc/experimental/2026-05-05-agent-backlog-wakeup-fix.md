# Agent delegation wakeup suppressed by backlog status default

**Date:** 2026-05-05  
**Branch:** linkcast/main  
**Fix commit:** f4a860bc  
**Upstream issues:** [#3279](https://github.com/paperclipai/paperclip/issues/3279), [#2884](https://github.com/paperclipai/paperclip/issues/2884)

## Symptom

When an agent creates a child issue and assigns it to another agent via
`POST /api/companies/:companyId/issues`, the assigned agent is never woken.
The issue sits in `backlog` indefinitely.

Discovered while testing the `openrouter_local` adapter: Fury (CEO) correctly
created probe issues for Stark and Natasha, but both stayed in `backlog` and
neither agent ran.

## Root cause

`queueIssueAssignmentWakeup` (`server/src/services/issue-assignment-wakeup.ts`)
had a single compound guard:

```ts
if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;
```

The `createIssueSchema` defaults `status` to `"backlog"` when the client omits
it. Agents creating delegation issues don't (and shouldn't need to) specify a
status — they're not doing backlog grooming, they're dispatching work. So the
guard suppressed the wakeup on every agent-created child issue.

The `requestedByActorType` field was already threaded through the call chain but
never consulted in the guard.

## Fix

Split the guard so the backlog suppression only applies to user and system
actors:

```ts
if (!input.issue.assigneeAgentId) return;
// Agents delegating work intend immediate execution; only suppress backlog
// wakeup for user/system actors.
if (input.issue.status === "backlog" && input.requestedByActorType !== "agent") return;
```

User-driven workflows are unchanged: backlog issues still require an explicit
status transition to wake their assignee. Agent-created issues with an assignee
fire the wakeup regardless of status.

## Relation to upstream issues

- **#3279** — same symptom via a different path: plugin host services call
  `svc.create()` directly and never invoke `queueIssueAssignmentWakeup` at all.
  Our fix does not help that case; #3279 requires adding the wakeup call inside
  the plugin host services handler.

- **#2884** — agent-to-agent comments not triggering wakeup. Separate code path
  but the same class of problem: agent-originating mutations being treated
  identically to user-originating ones when the desired semantics differ.

## Upstream PR recommendation

The fix is a two-line change to one file with no schema impact. Worth filing
against `paperclipai/paperclip` master. Note that the companion fix for #3279
(adding `queueIssueAssignmentWakeup` to plugin host services) should be
coordinated in the same PR or a linked one, since both share the same root
pattern.
