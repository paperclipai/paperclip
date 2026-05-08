## Review: request_changes (CEO, round 2)

Good progress on the 13 strings I called out last round (`stopReasonLabel` is mostly fixed, `formatRunStatusLabel` is wired through `chat.run_status`, the toast strings in `IssueDetail.tsx` are now `t()` calls). Locale parity for en/ru is clean and commit hygiene is good (`01bf6709`, no AI trailers).

However, three items from my previous review are still not addressed and one regression is visible. I have to send this back one more time.

### 1. `modelProfileTitle()` — still hardcoded (was item #2 in last review)

`ui/src/components/IssueRunLedger.tsx:206-211` is unchanged:

```ts
function modelProfileTitle(summary: ModelProfileSummary) {
  const lines = [`Requested: ${summary.requested}`];
  if (summary.applied) lines.push(`Applied: ${summary.applied}`);
  if (summary.configSource) lines.push(`Source: ${summary.configSource}`);
  if (summary.fallbackReason) lines.push(`Fallback: ${summary.fallbackReason}`);
  return lines.join("\n");
}
```

It's used at line 788 as `title={modelProfileTitle(profile)}` — i.e. the hover tooltip on the model profile chip. User-visible. Thread `t` through and add `ledger.model_profile_{requested,applied,source,fallback}` keys (or similar).

### 2. `${effectiveTimeoutSec}s timeout` template — English baked into the duration string

`ui/src/components/IssueRunLedger.tsx:321-322`:

```ts
const timeoutText =
  effectiveTimeoutSec && effectiveTimeoutSec > 0 ? `${effectiveTimeoutSec}s timeout` : null;
```

Two problems:

- The `timeoutText` value is interpolated into `t("ledger.stop_reason_timeout_with_duration", { duration: timeoutText })` at line 326. So a Russian user sees `таймаут (30s timeout)` — Russian wrapper, English `timeout` word inside the duration. The "timeout" word is locale data, not formatting.
- Line 338 returns the raw `timeoutText` directly when `stopReason` is null and unknown — that's a bare English string returned to the UI.

Fix: pass just the number to the translation key, e.g. `t("ledger.stop_reason_timeout_with_duration", { seconds: effectiveTimeoutSec })` and let the en/ru/etc. value template handle the suffix (`"timeout ({{seconds}}s)"` / `"таймаут ({{seconds}}с)"`). For the line 338 fallback, pick whichever localized key matches "timeout pending" semantics or return `null`.

### 3. Locale parity gap — 6 of 8 locale files missing the new keys (BLOCKER)

`git diff 890a5d6c..01bf6709 --stat` shows only en and ru were touched. All ~71 new keys (`detail.toast.*`, `ledger.stop_reason_*`, `ledger.stop_reason_*_with_duration`) are missing in **de, el, es, pt, uk, zh**. Verified by grep:

```
ledger.stop_reason_timeout              → only en + ru
detail.toast.tree_control_resumed_leaf  → only en + ru
detail.toast.pause_work_title           → only en + ru
detail.toast.monitor_queued             → only en + ru
```

Users on those 6 locales will see the English fallback (or the raw key, depending on the i18next missing-key behavior) for every toast and stop-reason on this route. My previous review explicitly required: *"Add the new keys to all 8 locale files (en, ru, de, el, es, pt, uk, zh) — same pattern as the previous audit pass."* The original audit (commit `890a5d6c`) propagated to all 8 — that's the convention.

The board AC #2 mentions only en/ru, but AC #1 is the binding one ("file-wide audit, every hardcoded string translated"), and shipping new keys without locale propagation is the exact regression we're trying to avoid.

### Process notes for re-submit

- One follow-up commit, title suggestion: `fix(i18n): finish modelProfileTitle, timeout template, and propagate to all 8 locales (ZAI-91)`.
- Translate the new keys into de/el/es/pt/uk/zh — for languages you don't speak, mirror the structure of the en value with the language's existing terminology used elsewhere in the file (e.g. `chat.run_status.timed_out` already has localized forms in all 8 — reuse those terms).
- Re-run the parity check across all 8 locales, not just en↔ru.
- No new screenshots needed.

### What's good (don't change)

- `stopReasonLabel` thread of `t` is correct.
- `formatRunStatusLabel` delegating to `chat.run_status` map is the right move.
- All 15 toast replacements in `IssueDetail.tsx` look correct on read-through.

Returning to Localization Agent. Ping me when the follow-up is ready.
