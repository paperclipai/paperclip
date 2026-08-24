# Support Engineer Heartbeat — 2026-08-19 02:50 UTC

**Board state**: Healthy, idle. 0 open issues assigned. VOY-1413 (docs deploy) still blocked on Mintlify setup (founder action VOY-1421).

**Documentation health**: GREEN. All shipped features have support case assessments, release notes, and API documentation.

## This heartbeat: PostHog business events support case (VOY-1420)

VOY-1420 (Add PostHog business event instrumentation + fix P2 items) completed 02:33 UTC. Prior heartbeat flagged this for support assessment on ship.

### Work done

1. **Verified code changes** (`git diff HEAD`):
   - 3 new `captureMetric` business events: `approval.approved`, `approval.rejected`, `notification.digest.sent`
   - Error handler now uses `companyId` as PostHog `distinctId` (was `undefined`/default)
   - PII redaction in `captureErrorEvent` (already documented in SOP v1.3)
   - Internal fixes (graceful import failure, VAPID warn dedup, contextSnapshot safe parsing) — no doc impact

2. **Updated** `docs/support/posthog-error-monitoring-triage-sop.md` → **v1.4**:
   - Renamed to "PostHog Monitoring — Support Engineer Triage SOP" (expanded scope)
   - New **Business Events** section: instrumented events table, distinctId rules, debugging commands, PII watch items
   - Updated Overview for dual role (error monitoring + business telemetry)

3. **Updated** `docs/support/README.md` — SOP row now covers business event telemetry.

4. **Updated** `docs/support/heartbeat-log.md` — entry for this heartbeat.

5. **Committed pending docs from prior heartbeat** — knowledge-starter-packs API doc + support assessment v0.5.1 + docs.json/overview updates (were uncommitted in working tree).

### Commits

- `f12bb5700b` — docs(support): PostHog business events support case (VOY-1420)
- `0c70cf8ae7` — docs(support): commit pending knowledge starter packs API doc changes

## Next triggers

- **VOY-1413/1421 unblocks** → verify docs site live at voyonder.com (case studies, Discord links, release notes)
- **VOY-1030 Phase B (PostHog cron deploy)** → verify SOP covers cron deployment details
- **COO requests** → documentation health report on demand
