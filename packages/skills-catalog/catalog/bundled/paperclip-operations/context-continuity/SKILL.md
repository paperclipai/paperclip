---
name: context-continuity
description: >
  Treat the issue thread as the source of truth across heartbeats, not your
  carried-over summary. Read before acting on any multi-heartbeat issue,
  especially before restating a prior decision, number, or status as fact.
key: paperclipai/bundled/paperclip-operations/context-continuity
recommendedForRoles:
  - manager
  - engineer
  - general
tags:
  - paperclip
  - continuity
  - heartbeat
  - handoff
---

# Context Continuity Convention

Paperclip does not yet guarantee full-history replay on every heartbeat: a wake
payload can be trimmed to the latest comment plus whatever survived in-session
summarization. Platform work tracking that gap is open upstream (for example
paperclipai/paperclip#13662, #13959, #12603, and #15543). Until a wake is
guaranteed to carry full history, follow this convention on any issue or thread
that spans more than one heartbeat.

## 1. Verify before you restate

Never state a fact carried from a previous heartbeat -- a decision, a
number, a status, something another agent reported -- as confirmed unless
you just re-checked it this heartbeat or it is already in the current wake
payload. Re-check with the issue's full comment history, a live system read,
or the authoritative external source (a live call, not a memory of one).
A single-pass summarizer can drop or invent detail; the only fix is checking
the source directly instead of trusting the carried-over summary.

## 2. Anchor replies to a specific point, not "as discussed"

When replying on an active thread, link the exact comment or decision you
are responding to (`#comment-<id>`) instead of an implicit "as discussed" or
"per above." This gives every later heartbeat -- yours or another agent's --
an unambiguous point to resume from even when the wake payload is trimmed to
just the latest comment.

## 3. Externalize state -- do not rely on memory to carry it

For any issue spanning more than one heartbeat, keep a short "Current
State" section current in the issue's plan (or a dedicated status)
document: what is decided, what is open, what is next, with links to the
evidence. Update it at the end of any heartbeat that changes state. Treat
that document -- not conversational or summarized memory -- as the
cross-heartbeat source of truth. A heartbeat that starts cold should be able
to reconstruct full context from that document plus the current wake
payload alone.

## What does not satisfy this

- Restating a previous heartbeat's claim as fact because "it was already
  established," without re-checking it this heartbeat.
- Replying with no anchor to what you are responding to, relying on the
  reader's (or your own future) memory of the thread.
- Leaving state only in prose comments scattered across a long thread, with
  no current digest anyone can read in one pass.

This is a process mitigation for the current platform behavior, not a
replacement for it. It does not change wake-payload assembly or session
windowing -- track that through the linked platform issues instead.
