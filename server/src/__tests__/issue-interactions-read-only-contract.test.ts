import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("aggregate issue view interactions contract", () => {
  it("hydrates interactions without expiry sweeps or activity writes", () => {
    const source = fs.readFileSync(new URL("../routes/issues.ts", import.meta.url), "utf8");
    const start = source.indexOf('router.get("/issues/:id/view"');
    const end = source.indexOf('router.get("/issues/:id/watchdog"', start);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain("listForIssue");
    expect(handler).not.toContain("expireRequestConfirmations");
    expect(handler).not.toContain("expirePendingInteractions");
    expect(handler).not.toContain("logActivity");
  });
});
