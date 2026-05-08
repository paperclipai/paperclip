/**
 * BBA Memory smoke test.
 *
 * Verifies that the memory module initialises, seeds, writes, and reads
 * correctly. Idempotent — safe to run multiple times. Useful right after
 * `pnpm install` to confirm better-sqlite3 compiled correctly on this box.
 *
 * Usage (from repo root or from server/):
 *   pnpm --filter @paperclipai/server exec tsx scripts/bba-memory-smoke.ts
 *   # or
 *   npx tsx server/scripts/bba-memory-smoke.ts
 */
import {
  initBbaMemory,
  closeBbaMemory,
  startTrainingSession,
  completeTrainingSession,
  startRun,
  completeRun,
  recordPopup,
  recordFailure,
  getSelectorsByPurpose,
  getPopupReviewQueue,
  reviewPopup,
  getSuccessStats,
  listRecentRuns,
  listAllSelectors,
} from "../src/services/bba-memory/index.js";

function banner(title: string) {
  console.log("\n" + "=".repeat(60));
  console.log("  " + title);
  console.log("=".repeat(60));
}

async function main() {
  banner("INIT");
  initBbaMemory();
  console.log("✅ DB initialised");

  banner("SEED CHECK");
  const overlays = getSelectorsByPurpose("overlay");
  console.log(`Overlay selectors seeded: ${overlays.length}`);
  if (overlays.length === 0) {
    throw new Error("Expected seed selectors for 'overlay' purpose");
  }
  console.log(
    "  Top 3 by priority:",
    overlays.slice(0, 3).map((s) => `[${s.priority}] ${s.selector}`),
  );

  const allSelectors = listAllSelectors();
  console.log(`Total seeded selectors across all purposes: ${allSelectors.length}`);

  banner("FAKE TRAINING SESSION");
  const sessionId = startTrainingSession({
    mode: "back-to-back",
    plannedRuns: 3,
    notes: "smoke test session",
  });
  console.log(`Started training session #${sessionId}`);

  // ---- Run 1: success ----
  const run1 = startRun({
    trainingSessionId: sessionId,
    source: "training",
    trigger: "smoke-1-of-3",
    sessionStatusBefore: "expired",
    cookieCountBefore: 0,
  });
  recordPopup({
    runId: run1,
    selector: "button:has-text('JOACĂ ÎN CONTINUARE')",
    matchedVisibleText: "JOACĂ ÎN CONTINUARE",
    action: "dismissed",
    outcome: "closed",
    urlPath: "/pariuri-online/fotbal",
    purpose: "overlay",
  });
  recordPopup({
    runId: run1,
    selector: "button:has-text('ACCEPT TOATE')",
    matchedVisibleText: "ACCEPT TOATE",
    action: "dismissed",
    outcome: "closed",
    urlPath: "/",
    purpose: "overlay",
  });
  completeRun(run1, {
    outcome: "success",
    sessionStatusAfter: "active",
    cookieCountAfter: 12,
    durationMs: 4_521,
    notes: "smoke success",
  });
  console.log(`Run #${run1} → success`);

  // ---- Run 2: CAPTCHA failure with a NEW popup ----
  const run2 = startRun({
    trainingSessionId: sessionId,
    source: "training",
    trigger: "smoke-2-of-3",
    sessionStatusBefore: "expired",
    cookieCountBefore: 12,
  });
  // Brand new popup that wasn't in the seed catalog → triggers review queue.
  const newPopupResult = recordPopup({
    runId: run2,
    selector: "[data-testid='promo-banner-2026'] button.dismiss",
    matchedVisibleText: "Promoția lunii — Bonus 100 lei",
    action: "dismissed",
    outcome: "closed",
    urlPath: "/",
    purpose: "overlay",
  });
  console.log(
    `Recorded popup (isNew=${newPopupResult.isNew}, popupId=${newPopupResult.popupId})`,
  );
  recordFailure({
    runId: run2,
    failureClass: "CAPTCHA_VISIBLE",
    step: "submit",
    selectorAttempted: "iframe[src*='recaptcha']",
    errorMessage: "reCAPTCHA challenge appeared after submit",
    url: "https://www.casapariurilor.ro/",
  });
  completeRun(run2, {
    outcome: "failure",
    failureClass: "CAPTCHA_VISIBLE",
    sessionStatusAfter: "expired",
    cookieCountAfter: 12,
    durationMs: 8_103,
  });
  console.log(`Run #${run2} → failure (CAPTCHA_VISIBLE)`);

  // ---- Run 3: success ----
  const run3 = startRun({
    trainingSessionId: sessionId,
    source: "training",
    trigger: "smoke-3-of-3",
    sessionStatusBefore: "expired",
    cookieCountBefore: 12,
  });
  completeRun(run3, {
    outcome: "success",
    sessionStatusAfter: "active",
    cookieCountAfter: 14,
    durationMs: 3_980,
  });
  console.log(`Run #${run3} → success`);

  completeTrainingSession(sessionId);
  console.log(`Closed training session #${sessionId}`);

  banner("REVIEW QUEUE");
  const pending = getPopupReviewQueue();
  console.log(`Popups awaiting review: ${pending.length}`);
  for (const p of pending) {
    console.log(`  [#${p.id}] ${p.selector_text}`);
    console.log(`         text="${p.matched_visible_text}"`);
  }
  if (pending.length > 0) {
    reviewPopup(pending[0].id, "approved");
    console.log(`Approved popup #${pending[0].id}`);
  }

  banner("STATS (last 7 days)");
  const stats = getSuccessStats(7);
  console.log(JSON.stringify(stats, null, 2));

  banner("RECENT RUNS");
  for (const r of listRecentRuns(10)) {
    console.log(
      `  #${r.id} [${r.source}/${r.trigger}] ${r.outcome ?? "running"}` +
        (r.failure_class ? ` (${r.failure_class})` : "") +
        (r.duration_ms ? ` — ${r.duration_ms}ms` : ""),
    );
  }

  banner("DONE");
  console.log("✅ All operations succeeded.");
  console.log("DB at: ~/.paperclip/bba-memory/bba-memory.db");

  closeBbaMemory();
}

main().catch((err) => {
  console.error("\n❌ Smoke test failed:");
  console.error(err);
  process.exitCode = 1;
});
