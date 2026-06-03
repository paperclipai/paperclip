# Design: Fix webhook raw-body corruption in the API→worker proxy

**Date:** 2026-06-03
**Tracker:** BLO-8568 (Phase 2 Block Kit buttons), related to BLO-8617 live-evidence pass
**Repo:** `Blockcast/paperclip`
**Status:** Approved (design), pending implementation plan

## Problem

Slack interactive **Approve/Reject buttons** (Block Kit `block_actions`) on approval cards in
`#paperclip-approvals` do nothing when clicked. Reaction-based approval (✅/❌) works; buttons fail 100%.

### Root cause (verified end-to-end in source + prod logs)

`paperclip.blockcast.net` resolves to the **API tier** (`paperclip-api-*` Deployment, 2 replicas).
Plugin webhook delivery is **worker-dependent**, so the API tier reverse-proxies the route
`POST /plugins/:pluginId/webhooks/:endpointKey` to the worker tier (`paperclip-0` StatefulSet) via
`server/src/routes/worker-tier-proxy.ts`. Two compounding defects corrupt the request body in transit:

1. **`worker-tier-proxy.ts:206`** re-serializes the body:
   ```js
   // express.json() already parsed the body; re-serialize as JSON.
   // Every allowlisted mutating route is a JSON endpoint.   ← false for Slack interactivity
   body = JSON.stringify(req.body ?? {});
   headers.set("content-type", "application/json");
   ```
   This discards the original raw bytes and forces `content-type: application/json`.

2. **`server/src/app.ts:273`** registers only `express.json({ verify: captureRawBody })` — there is
   **no `express.urlencoded()` parser** anywhere in `createApp` (shared by both tiers). So a
   form-urlencoded interactivity body is never parsed and `captureRawBody` never fires for it.

### Why each webhook class behaves as observed

Slack signs the **exact bytes** it sends. The worker verifies HMAC over `v0:${ts}:${rawBody}`
(`paperclip-plugin-slack/src/worker.ts:187`). Corrupting the bytes in the proxy breaks verification:

| Webhook class | Content-Type | Proxy effect | Result | Confidence |
|---|---|---|---|---|
| Reactions (`reaction_added/removed`) | `application/json` (compact, no escapes) | `JSON.stringify(parse(x))` happens to reproduce identical bytes | ✅ verifies | proven (works in prod) |
| Rich `message` events | `application/json` | `JSON.stringify(parse(x))` differs from Slack's bytes when the payload contains `\u`-escapes or non-canonical spacing/key-order | ❌ `hmac_mismatch` | **likely, unverified** |
| **Buttons (interactivity)** | `application/x-www-form-urlencoded` | `express.json` skips → `req.body={}` → proxied as literal `"{}"` | ❌ `hmac_mismatch`, 100% | **proven (ground-truthed)** |

**Mechanism correction (from eng-review outside voice):** the failure trigger for the JSON event
class is NOT "multibyte content" — multibyte round-trips fine (`café`, `🎉` re-serialize byte-identical).
The real trigger is whether the original JSON contains `\u`-escaped sequences or non-canonical
formatting (spacing, key order) that `JSON.stringify(JSON.parse(x))` does not reproduce. "Reactions
verify today" is therefore **luck, not correctness** — it holds only while Slack's reaction JSON stays
compact and escape-free. Any JSON webhook whose bytes aren't reproduced by re-serialization is silently
corrupted by the current proxy.

**Ground-truth (interactivity only):** the worker logged the interactivity rejection with
`bodyBytes:2, bodyFp:44136fa355b3`; `sha256("{}").slice(0,12) === "44136fa355b3"`, proving the worker
received the literal string `"{}"` — exactly what `JSON.stringify(req.body ?? {})` produces for an
unparsed form body. The rich-message and Linear classes have **no captured failing rawBody yet**; see
the rich-event capture test in Testing.

### Scope of impact (beyond Slack)

- **Slack interactivity:** broken 100% (buttons dead). **Proven, primary fix.**
- **Slack rich `message` events:** **likely** improved (the proxy stops re-serializing), but
  **unverified** — no captured failing rawBody. Corrects a prior investigation that attributed these to
  "Slack signs different bytes than it delivers, Slack-side, benign" (see
  `reference_paperclip_slack_signature_verified`) — the cause is *our* proxy, but the specific failing
  payload shape is not yet captured. Forwarding raw bytes can only help; we do not claim 100%.
- **Linear webhooks** (`paperclip-plugin-linear/src/worker.ts:1274`) verify HMAC over `input.rawBody`
  the same way. Linear is `application/json` (the same path reactions survive), and there is **no
  observed Linear `hmac_mismatch` in evidence** — Linear may be fine today. The fix removes the
  corruption risk (can only help) but "fixes a real Linear bug" is **speculative, unverified.**

**Version facts (verified):** Express **5.2.1**, body-parser **2.2.2**, Node 25 (undici). Note that
body-parser 2.2.2 has **no `req._body` flag** (that was express-4-era); parser skipping for an
already-consumed stream is via `onFinished.isFinished(req)` + content-type `shouldParse`. `express.json`
provably does not consume a urlencoded stream (content-type mismatch → `shouldParse` false → `next()`),
so adding `express.urlencoded` after `express.json` is safe.

The bug exists on **master** (the proxy body block is identical to `origin/master`); it is not specific
to any feature branch.

## Goals / Non-goals

**Goals**
- Slack interactivity buttons resolve approvals end-to-end (signature verifies + handler runs).
- Slack rich/multibyte events and Linear webhooks verify correctly (same root cause).
- No weakening of HMAC verification (it is a replay/forgery guard).

**Non-goals**
- No change to plugin signature-verification code (`verifySlackSignature` is correct).
- No signing-secret rotation (that is BLO-8723, an independent security item; not the cause here).
- No unrelated refactor of the proxy or body-parsing stack.

## Design

Two coordinated changes. Both are required: Change B fixes the **signature** (raw bytes), Change A fixes
the **handler** (the interactivity handler reads `req.body.payload`, which needs the form body parsed).

### Change A — `server/src/app.ts`: capture raw bytes for form-urlencoded

Add a `express.urlencoded` parser with the same `captureRawBody` verify hook, immediately after the
existing global `express.json()` (~line 276):

```js
app.use(express.urlencoded({
  extended: false,
  limit: DEFAULT_JSON_BODY_LIMIT,   // "10mb", reused from http/body-limits.ts
  verify: captureRawBody,
}));
// Catch-all: capture raw bytes for ANY other content-type so signature
// verification can never silently re-break when a future webhook arrives
// with a content-type neither json nor urlencoded handles.
app.use(express.raw({
  type: "*/*",
  limit: DEFAULT_JSON_BODY_LIMIT,
  verify: captureRawBody,
}));
```

Effect:
- **API tier:** `req.rawBody` is now populated for form-urlencoded interactivity requests (so Change B
  can forward the exact bytes), and for every other content-type via the `express.raw` catch-all.
- **Worker tier:** the forwarded form body parses into `req.body = { payload: "<json>" }`, which the
  Slack plugin's interactivity handler already expects
  (`paperclip-plugin-slack/src/worker.ts:2007` does `body?.payload ? JSON.parse(body.payload) : body`).

`extended: false` (qs off, uses the `querystring` lib) is sufficient — Slack sends a single flat
`payload=` field.

**Why the catch-all is safe (verified mechanism, corrected):** body-parser **2.2.2** has **no
`req._body` flag** (that was express-4 era). The skip guard is `onFinished.isFinished(req)`
(`body-parser/lib/read.js:40`): once `express.json` (or `urlencoded`) reads and consumes the stream for
a matching content-type, the request is "finished" → the trailing `express.raw` sees `isFinished===true`
→ skips without re-reading and **does not touch `req.body`**. `express.raw` only acts when neither
prior parser matched, in which case it sets `req.body` to a `Buffer`. **No existing inbound POST route
relies on a parsed `req.body` for a non-json/non-urlencoded content-type** (verified: no `multer` /
`busboy` / `req.file` upload routes; `COMPANY_IMPORT_API_PATH` is json-only; `text/plain` /
`octet-stream` references are all response types, not request bodies). So the catch-all adds no
regression for any route today and closes the latent footgun permanently.

### Change B — `server/src/routes/worker-tier-proxy.ts`: forward original bytes + content-type

Replace the re-serialization block (~lines 202–208) so the proxy forwards the **captured raw buffer**
verbatim and **does not override** the content-type:

```js
let body: BodyInit | undefined;
if (hasRequestBody(req)) {
  const stashedRaw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (stashedRaw) {
    // Forward the exact bytes the client sent so downstream HMAC signature
    // verification (Slack/Linear webhooks) sees what the provider signed.
    // Do NOT override content-type — forwardRequestHeaders carries the original.
    body = stashedRaw;
  } else {
    // Fallback for any internal caller whose body wasn't raw-captured:
    // re-serialize the parsed JSON (legacy behavior).
    body = JSON.stringify(req.body ?? {});
    headers.set("content-type", "application/json");
  }
}
```

Notes:
- `content-length` is hop-by-hop (stripped by `forwardRequestHeaders`); `fetch` recomputes it from the
  body. No manual length handling needed.
- The original `content-type` (`application/json` or `application/x-www-form-urlencoded`) and the
  `x-slack-signature` / `x-slack-request-timestamp` headers are already forwarded by
  `forwardRequestHeaders`.
- Genuinely-JSON internal routes (config save, bridge actions) now forward their original JSON bytes
  (which are byte-identical to what they sent), so they remain correct; the fallback covers any caller
  that somehow lacks a captured raw body.

## Data flow (after fix), interactivity button

1. Slack POSTs `application/x-www-form-urlencoded` `payload=<urlencoded-json>` with
   `x-slack-signature` to `paperclip.blockcast.net` → API tier.
2. API tier `express.urlencoded({verify: captureRawBody})` parses → `req.body={payload:...}`,
   `req.rawBody=<exact bytes>`.
3. `worker-tier-proxy` forwards `req.rawBody` verbatim + original content-type + Slack headers to the
   worker.
4. Worker `express.urlencoded` re-parses → `req.body={payload:...}`, `req.rawBody=<same bytes>`.
5. `plugins.ts` dispatches `handleWebhook({ rawBody, parsedBody:req.body, headers })`.
6. Plugin `verifySlackSignature(headers, rawBody)` → HMAC over the original bytes **matches**. ✅
7. Interactivity handler reads `body.payload` → `JSON.parse` → `block_actions` →
   `approval_approve`/`approval_reject` → allowlist check → `resolvePaperclipApproval` → card
   `chat.update`. ✅

## Testing (TDD — failing test first)

Framework: **vitest** + **supertest** (real in-process HTTP). Extend existing files; do not create
parallel harnesses. Existing homes: `server/src/__tests__/worker-tier-proxy.test.ts` (proxy harness with
a real worker-tier mock), `server/src/__tests__/plugin-webhook-verification.test.ts` (host body-parse),
`packages/plugins/paperclip-plugin-slack/src/__tests__/{signature-verification,approval-interactions}.test.ts`.

All seven are **regression-class** (the target behavior is currently broken) → mandatory per the IRON RULE.

1. **Proxy, form-urlencoded (RED→GREEN):** `application/x-www-form-urlencoded` request with body
   `payload=%7B...%7D` is forwarded to the worker with the **exact same raw bytes** and the original
   `content-type` (asserts NOT `"{}"`, NOT forced `application/json`). Fails today. → `worker-tier-proxy.test.ts`
2. **Proxy, JSON no-regression:** an `application/json` request forwards a byte-identical body and
   content-type. → `worker-tier-proxy.test.ts`
3. **Proxy, fallback guard:** when `req.rawBody` is absent but `req.body` is set, the legacy
   `JSON.stringify` path is used (keeps internal callers working). → `worker-tier-proxy.test.ts`
4. **App body-parsing (API tier):** a form-urlencoded POST yields `req.body.payload` populated and
   `req.rawBody` captured. → `plugin-webhook-verification.test.ts`
5. **Worker-role body-parsing:** assert the **worker** role's `createApp` also parses urlencoded (both
   tiers share `createApp`; if the body-parser config is ever split per-role this silently re-breaks).
   → `plugin-webhook-verification.test.ts` (or a worker-tier-specific test)
6. **Slack plugin interactivity entry point:** a correctly-signed `block_actions` payload passes
   `verifySlackSignature` AND drives the handler at `worker.ts:2006` (`body.payload` → `JSON.parse` →
   `approval_approve` → `resolveApproval`), plus the allowlist-reject branch. Covers the previously-dead
   path. → `approval-interactions.test.ts` / `signature-verification.test.ts`
7. **Rich-event capture + diff (de-risks the unverified claim):** capture one **real** rich Slack
   `message` event's rawBody (from prod logs or a fixture), assert `JSON.stringify(JSON.parse(rawBody))
   !== rawBody` (proving the corruption mechanism on a concrete payload), then assert it verifies after
   raw-byte forwarding. If we cannot obtain a real failing payload, mark the rich-message claim
   explicitly **unverified** rather than asserting a fabricated one. → `signature-verification.test.ts`

8. **Catch-all raw capture, no-regression:** a POST with a content-type neither json nor urlencoded
   (e.g. `text/plain`) has `req.rawBody` captured and is forwarded verbatim; assert no existing
   handler's `req.body` expectation is violated (it becomes a Buffer only for otherwise-unparsed
   requests). → `plugin-webhook-verification.test.ts`

**Catch-all decision (eng-review, then reversed by user):** the `express.raw({type:'*/*'})` catch-all
was initially proposed, then dropped as unnecessary, then **reinstated** — the user chose to build the
content-type-agnostic capture now to permanently close the silent-HMAC-re-break footgun, after
verifying it is safe (stream-consumed `onFinished` guard) and harms no existing route.

## Rollout & verification

- Branch off `master` (the bug is on master; do not stack on the outbox branch).
- PR → CI `docker.yml` builds `harbor.blockcast.net/paperclip/paperclip:sha-<7>-k8s-vendored` and
  helm-deploys on merge to `paperclip:master`. Do NOT hand-deploy.
- Post-deploy live verify: create an approval via API → card posts → click **Approve** button →
  approval flips to `approved` (API probe) + card `chat.update`s to "approved by …"; worker logs show
  the `slack-interactivity` webhook **accepted** (no `hmac_mismatch`).
- Confirm the benign rich-message `hmac_mismatch` stream in `slack-events` also stops.

## Risks

- **Blast radius:** Change B touches all worker-dependent proxied routes. Mitigated by the raw-body
  fallback and proxy regression tests (#2, #3).
- **Body limit:** urlencoded parser uses the same 10mb limit as JSON — consistent, no new exposure.
- **Security:** HMAC stays strict; this only restores the correct bytes for verification. No relaxation.
  The 5-minute replay window (`verifySlackSignature` via `x-slack-request-timestamp`, forwarded
  untouched) is unaffected.
- **Edge byte-transparency (assumption, ruled-in):** the fix assumes the cluster Cilium Gateway
  (out-of-repo; chart `ingress.enabled: false`) delivers Slack's bytes verbatim to the API tier. Proven
  indirectly: `application/json` reactions verify end-to-end today, so the edge is byte-transparent for
  JSON; urlencoded is the same transport. If buttons still fail post-fix, the gateway is the next
  suspect.

## NOT in scope

- **Slack signing-secret rotation (BLO-8723)** — independent security item; the secret is correct
  (fingerprint verified). Not the cause of the button failure.
- **Plugin signature-verification code** — `verifySlackSignature` is correct; no change.
- **Proving the Linear/rich-message fix** beyond a capture-and-diff test — if no real failing payload is
  available, those classes stay documented as "likely improved, unverified."
- (The `express.raw` catch-all was considered for deferral but is now **in scope** — see Design.)

## What already exists (reuse, not rebuild)

- `captureRawBody` (`app.ts:265`) — reused by the new `express.urlencoded` via the same `verify` hook.
- `forwardRequestHeaders` (`worker-tier-proxy.ts:102`) — already forwards original `content-type` +
  `x-slack-signature` + `x-slack-request-timestamp`; Change B just stops *overriding* content-type.
- `worker-tier-proxy.test.ts` — existing proxy harness (real worker mock + supertest); extend, don't fork.
- `signature-verification.test.ts` / `approval-interactions.test.ts` — existing Slack test homes.
- Plugin interactivity handler (`worker.ts:2007`) — already parses `body.payload` correctly; **no plugin
  code change needed.**

## Failure modes (per new/changed codepath)

| Codepath | Realistic prod failure | Test? | Error handling? | User sees? |
|---|---|---|---|---|
| Proxy forwards `req.rawBody` Buffer | `rawBody` unexpectedly undefined → empty body forwarded | yes (#3 fallback) | yes (`?? JSON.stringify` guard) | would degrade, not crash |
| `express.urlencoded` parse | malformed `payload=` → parse throws | partial | express returns 400 | Slack retries; card stays pending |
| Worker re-parse (both tiers) | body-parser config split per-role later | yes (#5) | none (silent re-break) | **silent** — flagged as the one to watch |
| Interactivity handler | `block_actions` without `action.value` | existing handler guards (`if (!actionValue) return`) | yes | button no-op |
| Signature verify post-fix | stale signing secret (BLO-8723) masquerades as "fix failed" | n/a | rejection logged | button dead, looks like fix didn't work |

**No critical gaps** (every failure has either a test or error handling). The closest to a silent
failure — a future per-role body-parser split — is covered by test #5 and called out explicitly.

## Implementation Tasks
Synthesized from this review's findings. Each derives from a specific finding. TDD: write the failing
test first, then the change.

- [ ] **T1 (P1, human: ~30min / CC: ~5min)** — `server/src/app.ts` — add `express.urlencoded({extended:false, limit: DEFAULT_JSON_BODY_LIMIT, verify: captureRawBody})` AND `express.raw({type:'*/*', limit: DEFAULT_JSON_BODY_LIMIT, verify: captureRawBody})` (catch-all) after the global `express.json`
  - Surfaced by: Root cause — no urlencoded parser; interactivity `req.body` never populated. Plus Arch Issue 1 — catch-all closes the content-type footgun (user chose to build now)
  - Files: `server/src/app.ts`
  - Verify: tests #4, #5, #8 (`req.body.payload` + `req.rawBody` on both roles; catch-all no-regression)
- [ ] **T2 (P1, human: ~45min / CC: ~10min)** — `server/src/routes/worker-tier-proxy.ts` — forward `req.rawBody ?? JSON.stringify(req.body ?? {})` + stop overriding content-type; widen `body` type to `BodyInit`; add guard comment
  - Surfaced by: Root cause — `JSON.stringify(req.body)` corrupts signed bytes (line 206)
  - Files: `server/src/routes/worker-tier-proxy.ts`
  - Verify: tests #1, #2, #3 (byte-fidelity, JSON no-regression, fallback)
- [ ] **T3 (P1, human: ~1h / CC: ~15min)** — tests — add the 8 regression tests across the existing files
  - Surfaced by: Test review — 0/8 new paths covered, all regression-class
  - Files: `worker-tier-proxy.test.ts`, `plugin-webhook-verification.test.ts`, `signature-verification.test.ts`, `approval-interactions.test.ts`
  - Verify: `pnpm run test:run`
- [ ] **T4 (P2, human: ~20min / CC: ~5min)** — capture a real rich Slack `message` rawBody for test #7, or mark the rich-message claim unverified
  - Surfaced by: Outside voice — rich/Linear claims unproven
  - Files: `signature-verification.test.ts` (fixture)
  - Verify: assert `JSON.stringify(JSON.parse(raw)) !== raw` on the real payload

## Parallelization

Sequential implementation, minimal parallelization opportunity. T1 (`app.ts`) and T2
(`worker-tier-proxy.ts`) touch different files and could be written in parallel, but both feed the same
test suite (T3) and the change is small enough (~2 files) that the coordination overhead isn't worth
splitting. Recommend: T1 → T2 → T3 (write failing tests first per TDD) → T4. Single lane.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (backend bugfix, not a product change) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | Codex 502 (no usable token) → Claude subagent fallback ran |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open→resolved | 1 arch + 1 code-quality + 7→8 test gaps + 0 perf |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (backend/proxy, no UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | n/a |

- **OUTSIDE VOICE (Claude subagent):** verified against installed deps. Caught (a) body-parser 2.2.2 has
  no `req._body` — corrected the catch-all's safety mechanism to `onFinished.isFinished`; (b) the
  rich-message failure trigger is `\u`-escapes/non-canonical JSON, not multibyte; (c) Linear "fixed" is
  unverified (no observed failure). All folded into the spec.
- **CROSS-MODEL:** Codex unavailable (502 no usable token in ccrotate pool); fell back to Claude
  subagent. Two cross-model tensions surfaced to user: (1) drop express.raw catch-all → user later chose
  to **build it** with the corrected mechanism; (2) soften rich-msg/Linear claims → **accepted**.
- **UNRESOLVED:** 0 — all findings decided by the user.
- **VERDICT:** ENG CLEARED — scope minimal (2 source files), root cause ground-truthed, 8 regression
  tests specified, 0 critical failure gaps. Ready to implement via TDD.
