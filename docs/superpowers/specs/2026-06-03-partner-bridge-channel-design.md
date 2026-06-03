# Design Spec — Inter-Partnership Communication Channel (partner-bridge)

- **Date:** 2026-06-03
- **Status:** Draft for review
- **Goal:** Automate communication between two isolated Paperclip companies —
  **Rossignol Voyage** (the conciergerie agency) and **Product Compass Consulting**
  (its outsourced Product Management partner) — over a supervised, board-gated channel
  that carries messages, tasks, and documents, transported via **Hermes** (Telegram + email).
- **Author:** Oleg (with Claude)
- **Related:** `2026-06-02-conciergerie-str-paperclip-design.md` (the agent company),
  `2026-06-03-soloway-travel-website-design.md` (re-skin, now Rossignol Voyage).

## 1. Purpose & scope

Paperclip companies are **isolated**: there is no native cross-company link (verified —
no cross-company/partner/referral mechanism in the codebase; agents expose only
`claude_local` / `human` / `external` / `webhook` / `openclaw_gateway` adapters). Today,
moving work between Rossignol Voyage and Product Compass Consulting is **manual** (an
operator creates a task in the partner company by hand — as was done once for `PRO-1`).

This project builds an **automated, supervised partnership channel** so the two companies'
agents can exchange messages, hand off tasks, and sync documents — while every
**commitment** (budget, contract, scope change, signature) is still **held at a native
Paperclip board-approval gate** before anything leaves the company.

**Architecture chosen: hybrid split (the user's "A + C").**
- **A — `plugin-partner-bridge`** (a Paperclip plugin): owns the in-Paperclip channel
  mirror, commitment classification, and **board-gate enforcement** (where approvals live).
- **C — Hermes connector** (Hermes-side): transport only — Telegram + email send/receive —
  behind a thin two-way contract the plugin calls. (**Openclaw gateway is explicitly not
  used; Hermes is the comms backbone**, consistent with the hermes-paperclip-adapter /
  MemoryOS already in use.)

**In scope (this spec — the Paperclip side):**
- The `plugin-partner-bridge` Paperclip plugin (state, mirror, classify, gate).
- The **contract** between the plugin and Hermes (`sendMessage` out, `inbound` in).
- The **channel-issue convention** + per-link configuration.
- A **v1 vertical slice**: automate the gated task+doc handoff end-to-end (the `PRO-1`
  flow), with Hermes mocked behind the contract so the plugin is testable standalone.

**Out of scope (deferred / separate specs):**
- **Hermes-side connector implementation** (different repo) — its own sub-spec; v1 mocks it.
- General free-form messaging at scale, group/multi-partner channels (>2 companies).
- Auto-negotiation of commitments (the human + board always decide).
- Migrating the existing `PRO-1` artifacts into the channel (one-off, manual).

## 2. Naming & actors

- **Rossignol Voyage** — Paperclip company `99418004-eea1-4bbb-9be7-9811b16f2b3b`,
  issue prefix **CON**. Internal agents coordinated by the **Agency Director** (`ceo`).
- **Product Compass Consulting (PCC)** — Paperclip company
  `e27fca3e-ecdd-4fb0-b563-d40b5381e4e4`, issue prefix **PRO**, CEO agent
  `cbe8d14d-…` ("Chief Product Officer & CEO").
- **Board** — the human-authoritative approver (`local-board`); commitments resolve here.
- **Operator / supervisor (you)** — receives Telegram notifications + approve/reject
  buttons; reads the formal email record.
- **Hermes** — the comms backbone (Telegram bot, Gmail, MemoryOS). Holds all transport
  secrets. The plugin never sees a Telegram token or Gmail credential.

## 3. Architecture / components

Three units + one contract. Each unit has one purpose and a defined interface.

### 3.1 `plugin-partner-bridge` (Paperclip plugin, TypeScript, str-ops-style)

The brain. Installed in the instance, configured **per partnership link**. On wakeup
(`requestWakeup` after channel activity + a periodic safety poll) it, for each linked
company's channel-issue:

1. **Detects new outbound items** since a per-channel cursor — new comments / created
   tasks / synced documents — **excluding** items the bridge itself authored
   (loop prevention, §5.2).
2. **Classifies** each item routine vs commitment (§4.1).
3. **Routine** → mirror to the peer company's channel-issue (post comment / create task /
   sync doc) + request a Telegram **notify** via the Hermes connector.
4. **Commitment** → do **not** mirror; create a native Paperclip **board approval** in the
   *sending* company + request a Telegram **approve/reject** via Hermes; hold.
5. On **approval resolved = approved** → mirror to peer + request an **email** formal record
   via Hermes + post confirmation on both channel-issues. On **rejected** → post rejection
   on the sender's channel-issue; do not mirror.

Reuses the str-ops plugin patterns: **CouchDB** for operational state via global `fetch`
(the host `ctx.http` egress gate blocks loopback — same workaround as str-ops); secrets via
`ctx.config` (instance config schema); managed capabilities declared in the manifest
(incl. `http.outbound`, `secrets.read-ref`); `createTestHarness` for tests.

### 3.2 Hermes connector (transport only — Hermes-side; this spec defines the contract)

A thin, swappable transport. Two directions:

- **Outbound — plugin → Hermes** (`POST {hermesBaseUrl}/partner-bridge/send`):
  ```jsonc
  {
    "bridgeMsgId": "uuid",          // idempotency key
    "channel": "telegram" | "email",
    "to": "chat:<id>" | "mailto:<addr>",
    "subject": "string?",            // email only
    "body": "markdown/text",
    "attachments": [{ "name": "...", "mime": "...", "url|base64": "..." }],
    "approvalId": "uuid?",           // present => render approve/reject affordance
    "linkId": "string"               // which partnership link
  }
  ```
- **Inbound — Hermes → plugin** (`POST {bridgeInboundUrl}/inbound`, HMAC-authenticated):
  ```jsonc
  {
    "channel": "telegram" | "email",
    "from": "string",
    "body": "string",
    "inReplyTo": "bridgeMsgId?",     // threads back to a sent message
    "approvalDecision": { "approvalId": "uuid", "decision": "approve" | "reject", "by": "string" }?,
    "linkId": "string"
  }
  ```

The plugin treats Hermes as opaque. v1 implements the plugin against this contract with a
**mock Hermes**; the real Hermes-side connector is a follow-up sub-spec in the Hermes repo.

### 3.3 Channel-issue convention

One tagged issue per company is **the channel**; its comments are messages, attached
documents are payloads, and linked tasks are hand-offs.

- Rossignol Voyage: `CON: ⇄ PCC partnership channel`.
- Product Compass Consulting: `PRO: ⇄ Rossignol partnership channel`.

The bridge **link configuration** maps the pair:
```jsonc
{
  "linkId": "rossignol-pcc",
  "companyA": { "companyId": "99418004-…", "channelIssueId": "<CON channel issue>", "label": "Rossignol Voyage" },
  "companyB": { "companyId": "e27fca3e-…", "channelIssueId": "<PRO channel issue>", "label": "Product Compass Consulting" },
  "transport": { "telegramChat": "chat:<your id>", "emailA": "<rossignol ops>", "emailB": "<pcc contact>" }
}
```

### 3.4 The contract is the only coupling

Plugin ⇄ Hermes communicate exclusively through §3.2. The board gate, classification, and
mirror live entirely in the plugin (Paperclip-native, auditable). Transport (and its
secrets) live entirely in Hermes. Either side can change internally without breaking the
other.

## 4. Behavior

### 4.1 Commitment classification

Priority order:
1. **Explicit** — the authoring agent tags the item: a `[COMMITMENT]` body prefix, a
   `commitment` label, or comment metadata `{ class: "commitment" }`. Preferred: agents
   declare intent.
2. **Heuristic fallback** — case-insensitive match on commitment keywords
   (`budget`, `montant`, `€`, `EUR`, `contrat`, `signature`, `engagement`, `devis`,
   `avenant`, `SOW`, `prix`, `facture`, `commande`).
3. **Ambiguity rule** — if uncertain, **classify as commitment** (fail-safe: over-gate,
   never under-gate). Routine is the explicit "safe" path only.

### 4.2 The gate (native + Hermes-surfaced — one decision, two faces)

A commitment produces a **Paperclip board approval** (kind `request_board_approval`, the
same kind as the existing `ecdbc8a1`) in the **sending** company — this is the
**authoritative** record. The Telegram message (with approve/reject buttons) is the
**convenient surface**: tapping approve flows Hermes → `inbound` → bridge → **resolves the
Paperclip approval**. The board gate is never bypassed by the channel.

State machine per commitment item: `pending → approved → sent` | `pending → rejected → blocked`.
A commitment item is **physically unable to mirror** while `pending`.

- **Approved** → mirror to peer + email formal record (commitments use email, the durable
  channel) + confirmation comments on both channel-issues.
- **Rejected** → rejection comment on sender's channel-issue + author notified; no mirror.
- **Routine** → mirror immediately + Telegram notify; no approval.

### 4.3 v1 vertical slice (the exact path to automate)

Mirrors the manual `PRO-1` flow; one run exercises every unit + the contract + both
transports + the gate:

1. **Routine out (Rossignol → PCC):** Director comments on the CON channel-issue and links
   the `brief-mission` document (kind `doc`, class routine).
   → bridge creates/updates a PCC task + syncs the `brief-mission` doc into PCC + posts a
   mirror comment + requests Telegram notify "📨 Rossignol → PCC: brief envoyé".
2. **Routine in (PCC → Rossignol):** PCC CEO replies on the PRO channel-issue
   ("Revue & cadrage livrés — réponse prête", + doc).
   → inbound/mirror posts the reply back to the CON channel-issue + Telegram notify.
3. **Commitment (Rossignol → PCC):** Director posts
   `[COMMITMENT] Lancer kickoff — budget 18–30 k€, signature mission` (class commitment).
   → bridge creates a Rossignol board approval + requests Telegram approve/reject; **holds**.
   → operator taps **approve** → Hermes → bridge resolves the approval → sends an **email**
   "Kickoff confirmé (réf. approval)" to PCC + mirrors to the PRO channel-issue + posts
   confirmation on both.

## 5. Errors, idempotency, security

### 5.1 Idempotency & delivery
- **Cursor** per channel-issue (last processed item ts+id); items processed exactly once.
- **Dedup map** `sourceItemId ↔ mirroredItemId` (also enables reply threading).
- Every mirror write + transport call carries a **`bridgeMsgId`** idempotency key →
  retries never duplicate.
- **Per-item flags** `mirrored / notified / emailed` so a partial failure (e.g. mirror OK
  but Telegram down) retries only the missing step.
- **At-least-once:** a Hermes send failure leaves the item unsent; retried with backoff.

### 5.2 Loop prevention
- Bridge-authored items carry a marker `bridgeOrigin: <peerCompanyId>` in metadata.
- The detector **ignores any item bearing `bridgeOrigin`** → a mirrored message is never
  re-mirrored back (explicit test in §6).

### 5.3 Approval lifecycle
- An unresolved approval triggers a **Telegram reminder after N days** (configurable);
  it **never auto-approves**. Expiry only escalates.

### 5.4 Security
- **Secrets** (Telegram bot token, Gmail credentials) live in **Hermes only**. The plugin
  holds just the Hermes base URL + a **shared auth token** (`ctx.config`, str-ops pattern).
- **Inbound webhook** is **HMAC-authenticated** (shared secret) so arbitrary callers cannot
  inject partner messages or forge approval decisions.
- **Cross-company writes:** the bridge uses an instance-scoped API token, **restricted to
  the two linked companies** via config. Loopback to the local Paperclip API uses global
  `fetch` (str-ops egress-gate workaround).
- **Gate integrity:** commitment-class items cannot mirror before their approval resolves
  (enforced by the §4.2 state machine, covered by tests).

## 6. Testing

- **Unit:** classifier (explicit tag / heuristic / ambiguous→commitment); envelope
  build+parse; loop-marker skip; cursor advancement; idempotency-key dedup; approval state
  machine transitions.
- **Contract (mock Hermes):** `send` called with the correct channel/payload for
  routine→Telegram vs commitment→email; `inbound` routes to the correct channel-issue;
  an `approvalDecision` resolves the right Paperclip approval.
- **Integration (`createTestHarness`, str-ops-style):** comment on channel-issue → peer
  mirror + (routine) Telegram notify; commitment → approval created + **no** mirror; resolve
  approval=approved → email send + mirror; inbound reply → mirrored back; loop test →
  bridge-authored item not re-mirrored.
- **E2E (live, str-ops Task-8 style):** real CouchDB + real Paperclip, Hermes mocked at the
  contract; run the §4.3 vertical slice; assert final state on both channel-issues + the
  approval record + the (mocked) email/Telegram calls.

## 7. Build sequence (slices) — for the plan

- **S0** Scaffold `plugin-partner-bridge` (manifest, capabilities, instance config schema,
  CouchDB state store via global `fetch`) — reuse str-ops scaffolding. Tests green, empty.
- **S1** Channel model + state: cursors, dedup map, envelope, loop marker. Unit tests.
- **S2** Detector + classifier (routine/commitment, fail-safe ambiguity). Unit tests.
- **S3** Mirror engine (comment/task/doc into peer company; idempotent; loop-safe).
  Integration tests with `createTestHarness`.
- **S4** Hermes contract + mock connector (`send` / `inbound`); routine Telegram notify
  path. Contract tests.
- **S5** Commitment gate: create board approval, hold, resolve via inbound decision, email
  formal record. State-machine + integration tests.
- **S6** Wire the v1 vertical slice (§4.3) end-to-end against mock Hermes; E2E live run.

## 8. Open items / follow-ups

- **Hermes-side connector** (real Telegram + email send/receive, HMAC, button rendering) —
  **separate sub-spec, Hermes repo.** v1 ships against the mock.
- **Wakeup vs poll cadence** — `requestWakeup` on channel activity + a periodic safety poll
  (the plan sets the interval; default conservative, ~10–15 min).
- **Channel-issue bootstrap** — create the two channel-issues + populate the link config
  (a small one-time setup step in the plan).
- **MemoryOS channel log** — optionally also write a human-readable channel transcript to
  Hermes MemoryOS (deferred; CouchDB is the operational store for v1).
- **Multi-partner / >2 companies, group channels** — deferred.
- **Issue prefix** — channel-issues use existing prefixes (CON / PRO).

## 9. Review log

- **2026-06-03 — created.** Decisions locked via brainstorming: transport = **Hermes**
  (Telegram + email; openclaw gateway explicitly excluded); autonomy = **hybrid** (routine
  auto, commitment board-gated + Telegram-approved → email record); payload = **messages +
  tasks + documents**; v1 = **vertical slice** (gated task+doc handoff); architecture =
  **hybrid split** (bridge plugin A + Hermes connector C, gate native in Paperclip).
  Hermes-side connector decomposed to a separate sub-spec; v1 mocks it behind the contract.
