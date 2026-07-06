---
title: Human-in-the-Loop (Review, Approvals, On-the-Go)
type: concept
status: reviewed
sources: [016, 017, 027, 029, 033, 038, 066, combo-05, xcombo-12, research-sources]
updated: 2026-06-24
---

# Human-in-the-Loop (Review, Approvals, On-the-Go)

In a 24/7 company the human is the **single point of stall**: work that needs approval freezes every
evening and weekend. This is the surface that makes governance fast and reachable.

## The review cockpit (combo-05)

One pipeline from "needs a human" → "decided":
- **Change-review (017)** — PR-style diff per run; approve a concrete change, not a vague work product.
- **Triage & batching (016)** — risk-score (trust × spend × sensitivity × diff size) → sorted, grouped
  inbox; conservative audited auto-approve for the low-risk tail.
- **Mobile push (027)** — web push/PWA on the same signals, gated by the risk score.
- **Digest (029)** — scheduled narrated summary ("shipped 12, marketing blocked 2d, 3 need you").
- **Delegation & coverage (038)** — scoped time-boxed approval handoff + SLA escalation when away.
- **Stakeholder page (033)** — tokenized read-only external view from the same narrator.

## On-the-go: the chat channel (idea 066)

A built-in **Telegram bot / WhatsApp** integration — the lowest-friction two-way surface. Pushes
approvals/digests/alerts and accepts **inline approve/reject taps** normalized back into structured
decisions (the **A2H — Agent-to-Human — protocol**, arXiv 2602.15831). Telegram first (no opt-in/template
friction); WhatsApp fast-follow (opt-in + 24h window + approved templates). Security crux: bind chat
identity to an authorized user, verify signatures, audit every chat-originated decision.

## Conversational Operator (xcombo-12, queued)

Board-chat + push + digest + voice/chat approvals as *one* conversational control surface — the natural
bridge for an [[aisha-integration|Aisha-as-chief]] front end over Paperclip via MCP.

## Links

Risk score shared with [[security-governance]]; the diff feeds [[observability-and-health]]
(run-to-run diffing spots diminishing-returns loops); delivery via [[external-integration]].

## Provenance

- Ideas `016,017,027,029,033,038,066`; combos `combo-05`, queued `xcombo-12`.
- `raw/research-sources.md` → `[chatops]`.

## Open questions for human review

- Notification-quality gating: which risk threshold actually buzzes the phone?
- Auto-approve & delegation authority model must be airtight against privilege escalation — review needed.
- Voice/chat as the *primary* operator surface (Aisha) vs. a secondary channel?
