# 020 — Outbound Secret-Leak Scanning

## Suggestion

Paperclip redacts secrets from its **own logs** (`log-redaction.ts`, `redaction.ts`,
`middleware/redact-sensitive.ts`). But agents produce a lot of *content* that flows back into
the control plane and out to humans — issue comments, work products, documents, attachments —
and nothing scans **that** content for leaked secrets. An agent that was bound a database
password or an API key (`agent-secret-bindings.ts`) can trivially paste it into a comment, a
generated config file, or a work product, where it's then stored in the DB, shown on the board,
and included in exports. That's a real exfiltration/leak path, and it's invisible today.

Add **outbound secret-leak scanning**: before agent-generated content is persisted or surfaced,
scan it for (a) the concrete secret values actually bound to that agent and (b) high-confidence
secret *patterns* (API key shapes, private keys, JWTs), then redact, block, or flag.

## How it could be achieved

1. **Reuse known secret values.** The agent's bound secrets are already resolvable via
   `agent-secret-bindings.ts` / `secrets.ts`. Exact-match scanning for those literal values
   (and common encodings) is high-precision and cheap.
2. **Pattern detection for the unknown.** Layer in regex/entropy detectors for generic secret
   shapes (`sk-…`, AWS keys, `BEGIN PRIVATE KEY`, bearer tokens) to catch secrets the agent
   generated or fetched that Paperclip never issued.
3. **Hook the write path.** Run the scan in the services that persist agent content — work
   products (`work-products.ts`), comments/issue threads (`issue-thread-interactions.ts`),
   documents (`documents.ts`) — reusing the existing redaction utilities.
4. **Graduated response.** Per company policy: *redact* (replace with `***` and keep the
   content), *block* (refuse to store, bounce back to the agent to fix), or *flag* (store but
   raise a high-priority inbox/approval item — pairs with risk-scored triage, idea 016).
5. **Audit every hit.** Record detections to `activity-log.ts` so operators can see leak
   attempts over time — a strong signal that an agent is misconfigured or compromised.

## Perceived complexity

**Medium.** The redaction primitives and the bound-secret lookups already exist, so exact-match
scanning is quick to add. The work is wiring it into every content-write path consistently (a
missed path is a silent hole) and tuning pattern detection to avoid false positives that mangle
legitimate output (e.g. a code sample that looks key-shaped). Start with exact-match on bound
secrets (near-zero false positives, immediate value), then add pattern detection behind a
confidence threshold.
