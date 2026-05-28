# AGE-391 Token-Package Rejection Triage Matrix (for AGE-63)

This runbook prepares a deterministic rejection triage path for [AGE-63](/AGE/issues/AGE-63) so execution can proceed immediately after owner-input blocker [AGE-157](/AGE/issues/AGE-157) clears.

It reuses the execution shape from [AGE-349](/AGE/issues/AGE-349) and [AGE-367](/AGE/issues/AGE-367): single-outcome routing, sanitized evidence, and copy/paste-ready parent/downstream updates.

## 1) Immediate rejection-triage checklist

Run this in exact order when a token package attempt is rejected or uncertain:

1. Confirm the rejection signal came from the current [AGE-63](/AGE/issues/AGE-63) execution window.
2. Record UTC chronology markers (`attempt_started_at_utc`, `rejection_detected_at_utc`, `triage_posted_at_utc`).
3. Validate non-secret checkpoints (Section 2) and classify rejection reason class (Section 4).
4. Route one and only one outcome from Section 3 (`package_accepted`, `package_rejected_recoverable`, `package_rejected_blocking`).
5. Post canonical triage update on [AGE-63](/AGE/issues/AGE-63) using Section 6 snippet.
6. Post downstream posture update using Section 7 snippet.
7. Confirm redaction boundary check passed before each comment.

Stop rule:

- If routed outcome is not `package_accepted`, do not claim publish readiness downstream.

## 2) Deterministic validation checkpoints

Use these checkpoints before selecting an outcome.

| Checkpoint | Required | Sanitized pass/fail format |
| --- | --- | --- |
| UTC chronology present | Yes | `chronology_complete=yes|no` |
| UTC ordering valid | Yes | `chronology_order_valid=yes|no` |
| Owner identity field present | Yes | `owner_field_present=yes|no` |
| Scope field present | Yes | `scope_field_present=yes|no` |
| Expiry field present and parseable | Yes | `expiry_field_valid=yes|no` |
| Schema validation summary | Yes | `schema_check=pass|fail` |
| Callback integrity summary | Yes | `callback_integrity=pass|fail|not_applicable` |
| Rejection reason classification assigned | Yes | `reason_class=<class_name>` |
| Redaction safety check | Yes | `redaction_safe=yes|no` |

Chronology gate:

- `attempt_started_at_utc <= rejection_detected_at_utc <= triage_posted_at_utc`
- Any missing/contradictory timestamp forces non-accepted routing.

## 3) Outcome routing matrix

| Outcome | Trigger condition | Owner | Immediate action | Retry vs stop |
| --- | --- | --- | --- | --- |
| `package_accepted` | Required fields complete, chronology valid, validation checkpoints pass, rejection disproven/transient | Backend execution owner on [AGE-63](/AGE/issues/AGE-63) | Post canonical accepted triage and continue normal closeout fanout | Continue (GO) |
| `package_rejected_recoverable` | Rejection is real but recoverable in-place (missing non-secret field, temporary callback mismatch, stale but replaceable metadata) | Backend execution owner with targeted blocker-owner follow-up on [AGE-157](/AGE/issues/AGE-157) | Post recoverable rejection triage, request exact remediation, keep downstream waiting | Retry after remediation; no readiness claim |
| `package_rejected_blocking` | Hard rejection or invalid package requiring fresh owner-input/callback cycle (invalid owner target, unusable callback, repeated schema failure, contradictory chronology) | Backend execution owner escalating to blocker owner path on [AGE-157](/AGE/issues/AGE-157) | Post blocking triage with concrete unblock action and halt downstream progression | Stop until fresh package attempt |

Single-route rule:

- Choose exactly one outcome per triage event; do not combine recoverable and blocking states in one canonical update.

## 4) Rejection reason classification

Use one primary reason class in canonical evidence:

| Reason class | Typical signal | Default route |
| --- | --- | --- |
| `missing_required_non_secret_field` | Owner/scope/expiry field omitted | `package_rejected_recoverable` |
| `callback_integrity_mismatch` | Callback metadata malformed/inconsistent for current run | `package_rejected_recoverable` unless repeated/contradictory chronology |
| `schema_validation_failure` | Required package shape check fails | `package_rejected_blocking` when repeated or unrecoverable in-run |
| `owner_identity_invalid` | Owner URN target not authorized/usable for posting path | `package_rejected_blocking` |
| `chronology_contradiction` | UTC sequence impossible or stale evidence conflict | `package_rejected_blocking` |
| `transient_verification_noise` | Probe failed once but rerun/checkpoints pass | `package_accepted` |

Escalation rule:

- If the same reason class appears in two consecutive attempts without correction evidence, route to `package_rejected_blocking`.

## 5) Sanitized evidence template

Use this packet shape before posting parent or downstream updates.

| Evidence section | Required contents | Redaction boundary |
| --- | --- | --- |
| UTC chronology | `attempt_started_at_utc`, `rejection_detected_at_utc`, `triage_posted_at_utc` | Never include raw callback URL/query |
| Validation checkpoints | Section 2 pass/fail markers | Never include token/auth secret material |
| Rejection classification | single `reason_class` + one-line rationale | No account identifiers beyond allowed URN format |
| Outcome routing | one of three Section 3 outcomes | No hidden/raw payload dumps |
| Next action + owner | explicit owner + concrete remediation/unblock step | No credentials in remediation text |

Required redaction line in every comment:

- `Redaction check: no credentials, tokens, raw callback payloads, or account identifiers beyond sanitized URN type.`

## 6) Copy/paste canonical parent snippet (AGE-63)

```md
## Token-Package Rejection Triage (AGE-391)

- Source issue: [AGE-63](/AGE/issues/AGE-63)
- Prepared via: [AGE-391](/AGE/issues/AGE-391)
- Related prep artifacts: [AGE-349](/AGE/issues/AGE-349), [AGE-367](/AGE/issues/AGE-367)
- Attempt started at (UTC): <YYYY-MM-DDTHH:mm:ss.sssZ>
- Rejection detected at (UTC): <YYYY-MM-DDTHH:mm:ss.sssZ>
- Triage posted at (UTC): <YYYY-MM-DDTHH:mm:ss.sssZ>
- Validation checkpoints: chronology_complete=yes|no; chronology_order_valid=yes|no; owner_field_present=yes|no; scope_field_present=yes|no; expiry_field_valid=yes|no; schema_check=pass|fail; callback_integrity=pass|fail|not_applicable
- Rejection reason class: missing_required_non_secret_field | callback_integrity_mismatch | schema_validation_failure | owner_identity_invalid | chronology_contradiction | transient_verification_noise
- Routed outcome: package_accepted | package_rejected_recoverable | package_rejected_blocking
- Next action owner: backend_execution_owner | blocker_owner
- Next action: <single concrete remediation or unblock action>
- Redaction check: no credentials, tokens, raw callback payloads, or account identifiers beyond sanitized URN type.

### Routing posture

- `package_accepted`: continue closeout/fanout path.
- `package_rejected_recoverable`: request targeted remediation and keep downstream waiting.
- `package_rejected_blocking`: halt downstream progression and request fresh owner-input/callback cycle.
```

## 7) Copy/paste downstream status snippet

Use after canonical [AGE-63](/AGE/issues/AGE-63) triage update is posted.

```md
## Token-Package Triage Status Update

- Canonical triage source: [AGE-63](/AGE/issues/AGE-63)
- Triage matrix source: [AGE-391](/AGE/issues/AGE-391)
- Received at (UTC): <YYYY-MM-DDTHH:mm:ss.sssZ>
- Routed outcome: package_accepted | package_rejected_recoverable | package_rejected_blocking
- Reason class: <from canonical source>
- Execution posture: proceed | waiting_remediation | blocked_fresh_package_required

Redaction check: no credentials, tokens, raw callback payloads, or account identifiers beyond sanitized URN type.
```

Suggested downstream order:

1. [AGE-59](/AGE/issues/AGE-59)
2. [AGE-56](/AGE/issues/AGE-56)
3. [AGE-51](/AGE/issues/AGE-51)
4. [AGE-47](/AGE/issues/AGE-47), [AGE-41](/AGE/issues/AGE-41), [AGE-30](/AGE/issues/AGE-30), [AGE-26](/AGE/issues/AGE-26), [AGE-16](/AGE/issues/AGE-16), [AGE-5](/AGE/issues/AGE-5)

If outcome is not `package_accepted`, post waiting/blocked posture only (no readiness claims).
