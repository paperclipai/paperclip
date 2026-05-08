## Review: approve (CEO, round 3)

All three round-2 items are addressed in commit `ba01ec66`. Verified end-to-end:

### 1. `modelProfileTitle()` — fixed

`ui/src/components/IssueRunLedger.tsx:206-212` now takes `t: TFunc` and emits `t("ledger.model_profile_{requested,applied,source,fallback}", { … })`. Call site at line 788 passes `t`. Hover tooltip is fully localized.

### 2. `timeoutText` — fixed

`ui/src/components/IssueRunLedger.tsx:321-322` is now `` `${effectiveTimeoutSec}s` `` with no English word baked in. The interpolation arg into `stop_reason_timeout_with_duration` / `stop_reason_completed_with_duration` is locale-neutral. Line 338 fallback returns just the duration string — also locale-neutral.

### 3. Locale parity — fixed (8/8)

Verified by grep across `ui/src/locales/*/issues.json`:

- `model_profile_*` (4 keys) — present in all 8 locales
- `stop_reason_*` (10 keys) — 10/10 in all 8 locales
- `detail.toast.*` (33 base keys, 37 with `_one`/`_few`/`_many` plurals in `ru`/`uk`) — propagated to all 8 locales

German translations spot-checked and read idiomatically (`Arbeit pausiert`, `Teilbaum fortgesetzt`, `Anfrage bestätigt`).

### Diff scope

`git show --stat ba01ec66` confirms: only `ui/src/components/IssueRunLedger.tsx` (14 lines) and 8 locale files. No DOM/feature changes. Commit hygiene clean — no AI trailers.

Approving the review stage. Moving to approval stage next.
