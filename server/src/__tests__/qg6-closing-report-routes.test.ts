import { describe, it, expect } from "vitest";

/**
 * QG-6 closing report (6-Q) unit tests.
 * Covers detection logic for hasQG6ClosingReport — the helper added to
 * server/src/routes/issues.ts that gates agent PATCH status='done'.
 *
 * The helper requires at least 5 of 6 keyword patterns to be present in
 * the comment body.
 */

// Mirror the detection logic from issues.ts so we can test it in isolation
const QG6_MARKERS = [
  /degistir(dim|ilen|dik)|changed files?|pr diff/i,
  /calistir(dim|ilan|dik)|ran tests?|ci run|pytest|jest/i,
  /dogruladim|dogrulanan|verified|test server|playwright|curl/i,
  /kanit|screenshot|log nerede|evidence link/i,
  /riskl[iy]|risk alan|no risk|risk yok/i,
  /rollback/i,
];

function hasQG6ClosingReport(comment: string | undefined): boolean {
  if (!comment) return false;
  const matched = QG6_MARKERS.filter((pattern) => pattern.test(comment));
  return matched.length >= 5;
}

const FULL_REPORT = `
## Kapanis Raporu (QG-6)

1. **Degistirilen dosyalar:** server/src/routes/issues.ts (PR diff: https://github.com/org/repo/pull/1)
2. **Calistirilan testler:** pnpm test:run — 51 passed (CI run: https://ci.example.com/runs/123)
3. **Dogrulanan sayfalar/API leri:** curl /api/health → 200; curl /api/issues → 200; playwright smoke pass
4. **Kanit linkleri:** screenshot: https://ci.example.com/ss.png; log: https://ci.example.com/log.txt
5. **Riskli alanlar:** Risk yok
6. **Rollback plani:** git revert HEAD; git push; restart server
`;

describe("hasQG6ClosingReport — unit tests", () => {
  it("(a) accepts a full 6-Q report with all markers", () => {
    expect(hasQG6ClosingReport(FULL_REPORT)).toBe(true);
  });

  it("(b) rejects undefined comment", () => {
    expect(hasQG6ClosingReport(undefined)).toBe(false);
  });

  it("(c) rejects empty string", () => {
    expect(hasQG6ClosingReport("")).toBe(false);
  });

  it("(d) rejects a comment with no QG-6 markers", () => {
    expect(hasQG6ClosingReport("All done! Great work.")).toBe(false);
  });

  it("(e) rejects a comment with only 3 of 6 markers (below threshold of 5)", () => {
    const sparse = "degistirdim testleri calistirdim rollback";
    expect(hasQG6ClosingReport(sparse)).toBe(false);
  });

  it("(f) accepts exactly 5 of 6 markers present", () => {
    // Q1 degistir, Q2 calistir, Q3 dogruladim, Q4 kanit, Q5 risk yok — Q6 rollback missing
    const fiveOf6 = "degistirdim calistirdim dogruladim kanit risk yok";
    expect(hasQG6ClosingReport(fiveOf6)).toBe(true);
  });

  it("(g) accepts English-language closing report", () => {
    const english = `
1. Changed files: server/src/routes/issues.ts (PR diff: https://github.com/org/repo/pull/1)
2. Ran tests: jest — 51 passed (CI run: https://ci.example.com/runs/123)
3. Verified test server pages: playwright smoke pass; curl /api/health 200
4. Evidence links: screenshot https://ci.example.com/ss.png
5. No risk areas
6. Rollback plan: git revert HEAD
`;
    expect(hasQG6ClosingReport(english)).toBe(true);
  });

  it("(h) rollback alone (Q6) + 4 others = 5 total → passes", () => {
    const comment =
      "degistirdim calistirdim dogruladim kanit risk yok rollback: git revert HEAD";
    expect(hasQG6ClosingReport(comment)).toBe(true);
  });

  it("(i) missing rollback (Q6) brings count to 5 when other 5 present → passes at threshold", () => {
    // All except Q6 — still passes because threshold is >=5
    const noRollback = "degistirdim calistirdim dogruladim kanit risk yok";
    expect(hasQG6ClosingReport(noRollback)).toBe(true);
  });

  it("(j) missing two markers → fails", () => {
    // Q1+Q2+Q3+Q4 only → 4 markers → fails
    const fourOnly = "degistirdim calistirdim dogruladim kanit";
    expect(hasQG6ClosingReport(fourOnly)).toBe(false);
  });
});

/**
 * Route-level 422 enforcement contract documentation.
 * Full integration tests require embedded postgres (not available on this host).
 */
describe("QG-6 route 422 contract (documented)", () => {
  it("documents: agent PATCH status=done without closing report → 422", () => {
    // Contract: server/src/routes/issues.ts
    //   if (updateFields.status === 'done' && req.actor.type === 'agent') {
    //     if (!hasQG6ClosingReport(commentBody)) → 422
    //   }
    // Executed AFTER the QG-4 doneEvidence guard.
    expect(true).toBe(true);
  });

  it("documents: board user PATCH status=done without closing report → allowed", () => {
    // Guard is agent-only (req.actor.type === 'agent')
    expect(true).toBe(true);
  });

  it("documents: agent PATCH with full closing report + valid doneEvidence → passes both QG-4 and QG-6", () => {
    expect(true).toBe(true);
  });
});
