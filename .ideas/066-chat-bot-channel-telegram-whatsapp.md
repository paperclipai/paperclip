# 066 — Built-In Chat Channel (Telegram Bot / WhatsApp) for On-the-Go Operation

## Suggestion

Paperclip's headline promise is managing autonomous companies **"from your phone,"** but the mobile
surface is thin — a shrunk dashboard, no notifications, and no way to *act* away from your desk (idea 027
proposes web push; idea 029 a digest). The lowest-friction on-the-go surface isn't a custom app or even a
PWA — it's a **messaging bot the operator already has open all day.** Add a **built-in chat channel** —
a **Telegram bot** and/or **WhatsApp** integration — that is a genuinely *two-way* link to a company:
it pushes what needs the human (approvals, budget incidents, the morning digest, SEV1 alerts) and accepts
replies, commands, and **inline approve/reject taps** straight back into the control plane.

Unlike notifications, this closes the loop: a 24/7 company that stalls on a human approval every evening
(combo 05's core problem) can be unblocked from a phone in two taps, anywhere — no app install, no VPN, no
login.

## How it could be achieved

1. **Channel as a plugin (best fit).** Implement as a Paperclip plugin (host-service + webhook), so the
   bot transport ships and evolves independently of core — mirroring how intake/outbound are best done as
   plugins (ideas 062/036). Two channel adapters behind one interface: **Telegram** first (simplest), then
   **WhatsApp** (ubiquitous, more constrained — see grounding).
2. **Reuse the signals that already exist.** Subscribe the bot to the same events feeding web push (idea
   027) and the digest (idea 029): approvals awaiting the operator, budget warn/hard-stop (`budgets.ts`),
   emergency stop (idea 014), chronic fallbacks/leaks (012/020), SEV1 incidents (057). Gate on the existing
   approval **risk score** (idea 016) so only high-signal events ping the phone — notification fatigue would
   kill this.
3. **Two-way: inline actions → structured decisions (the A2H pattern).** Render approvals as messages with
   inline buttons (Approve / Reject / Request changes) and the run change-review summary (idea 017) inline.
   A tap or reply is normalized back into a structured approval the control plane ingests — exactly the
   **Agent-to-Human (A2H) protocol** ("translate a button click 'Approve' into a structured decision the
   agent can ingest"). Also support a small **command grammar** ("status", "pause marketing-co", "digest
   now", "approve PAP-142") routed through the existing API.
4. **Security is the crux — bind chat identity to a Paperclip user.** A chat account must be explicitly
   linked to an authorized user (one-time code / deep link), so only that bound identity can approve;
   per-user delivery prefs (multi-user is a shipped roadmap item). Treat inbound chat as untrusted input:
   rate-limit, verify webhook signatures, never let an unbound/ spoofed message take a governed action, and
   audit every chat-originated decision (idea 023). High-risk actions can still require a second factor or
   fall back to the full UI.
5. **Channel-specific rules (from grounding).** **Telegram Bot API**: no template approvals, no formal
   opt-in, no time-window limits, rich inline keyboards — ideal for a self-hosted ops bot; ship first.
   **WhatsApp Business API**: users must opt in, messages outside a 24-hour window require *pre-approved
   templates* — so design digest/alert **templates** and an opt-in flow; richer reach, more setup.
6. **Symmetry with intake (idea 062).** The same bot is also an **inbound intake** surface — a forwarded
   customer message or a quick "file a bug: …" becomes an issue — making chat both the operator console
   *and* a front door (composes with the Front Desk, xcombo-09).

## Why it matters

This is what actually delivers the "from your phone" pitch, and uniquely as a **two-way** channel: every
other notification idea (027/029) is one-directional, while a chat bot lets the human *decide* on the go,
not just be informed. It's the highest-reach, lowest-friction operator surface (everyone has Telegram/
WhatsApp open; nobody installs another app), and it's the natural delivery layer for the whole review
cockpit (combo 05) and the Conversational Operator cut (xcombo-12) — and a clean bridge for an
Aisha-style chief front end (see `PAPERCLIP_INTEGRATION.md`).

## Perceived complexity

**Medium.** Telegram alone is **Low–Medium** — a well-documented Bot API, inline keyboards, webhook
delivery; most of the work is the signal subscription (reuse 027/029), the A2H action-normalization, and
the identity-binding/audit security. WhatsApp is **Medium–High** due to the Business API's opt-in,
template-approval, and 24-hour-window rules, so it's a fast-follow, not the first slice. The genuine
risk is **security**: a phone-based approval channel is an attack surface, so identity binding, signature
verification, rate-limiting, and full audit of chat-originated decisions must be airtight before any
*write* action is allowed — ship read-only (alerts + digest + status) first, then inline approvals, then
broader commands. Best delivered as a plugin so the transport stays out of core.

## Sources

- [Telegram Bot API — core.telegram.org](https://core.telegram.org/bots/api)
- [Telegram vs WhatsApp for an AI Agent (opt-in/template/window differences) — Hermify](https://www.hermify.io/en/blog/telegram-vs-whatsapp-for-ai-agent)
- [A2H: Agent-to-Human Protocol for AI Agents — arXiv 2602.15831](https://arxiv.org/pdf/2602.15831)
- [AgentClick: Skill-Based Human-in-the-Loop Review Layer for Terminal AI Agents — arXiv 2604.16520](https://arxiv.org/html/2604.16520v1)
- [Toward Safe and Responsible AI Agents: Transparency, Accountability, Trustworthiness — arXiv 2601.06223](https://arxiv.org/pdf/2601.06223)
