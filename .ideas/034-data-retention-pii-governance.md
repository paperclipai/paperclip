# 034 — Data Retention & PII Governance

## Suggestion

Autonomous agents generate and store enormous amounts of content indefinitely — run transcripts
(`RunTranscriptView`, `useLiveRunTranscripts`), comments, documents, work products, activity
logs, cost events. Paperclip has piece-wise hygiene (`plugin-log-retention.ts`, `log-redaction`,
`redaction`), but no **company-level data retention or PII governance**: nothing ages out old
transcripts, purges data on request, or scrubs personal information that agents inevitably
ingest (customer emails, names, support tickets) and then persist forever. For anyone operating
a real business — especially under GDPR/CCPA-style obligations — "we keep every agent transcript
indefinitely and never scrub PII" is a liability, and it also bloats the database over time.

Add **configurable data retention and PII governance**: retention policies that age out or
anonymize old data, and PII detection/redaction on stored content, with a defensible deletion
path.

## How it could be achieved

1. **Retention policies per company.** Operator-set TTLs by data class (transcripts, completed-
   issue threads, activity logs, cost-event detail), enforced by a routine (`routines.ts`).
   Generalize the existing `plugin-log-retention.ts` pattern from plugin logs to core data.
2. **Tiered handling.** Per class: *delete*, *anonymize* (strip PII, keep structure for
   analytics/audit), or *archive* (move to cold storage via the storage layer). Keep
   tamper-evident audit entries (idea 023) even when their referenced content is purged — retain
   the proof, drop the payload.
3. **PII detection.** Reuse/extend the redaction utilities and the outbound-secret-leak scanner
   (idea 020) to also flag personal data (emails, phone numbers, names) in stored content,
   redacting or tagging it for retention handling.
4. **Right-to-erasure path.** A scoped "purge all data relating to <subject/identifier>"
   operation across transcripts, comments, documents, and work products — the concrete capability
   a privacy request demands — with the action itself audited.
5. **Defaults & disclosure.** Ship sensible default retention windows and surface "what we keep
   and for how long" so operators can reason about (and configure) their exposure.

## Perceived complexity

**Medium.** Retention scheduling has an in-repo precedent (`plugin-log-retention.ts`) to
generalize, and PII detection can build on existing redaction primitives, so the mechanics are
tractable. The hard parts are correctness and completeness: deletion/anonymization must reach
*every* place a piece of data was copied (transcripts, exports, caches, search indexes) or
"erasure" is a false promise, and anonymization must preserve enough for analytics/audit without
re-identifiability. Reconciling retention with the tamper-evident log (keep proof, drop payload)
also needs deliberate design. Ship retention TTLs first (clear value, lower risk), then PII
detection, then full right-to-erasure.
