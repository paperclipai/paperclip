import { describe, expect, it } from "vitest";
import {
  RESOURCE_CEILING_CONTINUATION_MAX_ROUNDS_PER_WINDOW,
  RESOURCE_CEILING_CONTINUATION_PROGRESS_SAMPLE_LIMIT,
  countUnproductiveResourceCeilingContinuationRounds,
} from "../services/resource-ceiling-continuation.js";

/**
 * TSMC-21320: the cap must be spent on unproductive rounds only. These drive
 * the counter through a stub db so the accounting is asserted directly, without
 * standing up the whole heartbeat.
 */
function stubDb(grants: string[], progressRunIds: string[]) {
  let call = 0;
  return {
    select() {
      call += 1;
      const rows = call === 1
        ? grants.map((id) => ({ id }))
        : progressRunIds.map((runId) => ({ runId }));
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(rows),
        then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
      };
      return chain;
    },
  } as never;
}

const input = { companyId: "c1", agentId: "a1", issueId: "i1" };

describe("progress-aware continuation rounds", () => {
  it("counts nothing when no rounds were granted", async () => {
    expect(await countUnproductiveResourceCeilingContinuationRounds(stubDb([], []), input))
      .toEqual({ unproductive: 0, granted: 0, productive: 0 });
  });

  it("does not spend the cap on rounds that moved the issue", async () => {
    const r = await countUnproductiveResourceCeilingContinuationRounds(
      stubDb(["r1", "r2", "r3"], ["r1", "r2", "r3"]), input);
    expect(r).toEqual({ unproductive: 0, granted: 3, productive: 3 });
    // The TSR-5723 shape: three successful continuations must NOT reach the cap.
    expect(r.unproductive).toBeLessThan(RESOURCE_CEILING_CONTINUATION_MAX_ROUNDS_PER_WINDOW);
  });

  it("still spends the cap on rounds that left nothing behind", async () => {
    const r = await countUnproductiveResourceCeilingContinuationRounds(
      stubDb(["r1", "r2", "r3", "r4", "r5"], []), input);
    expect(r).toEqual({ unproductive: 5, granted: 5, productive: 0 });
    expect(r.unproductive).toBeGreaterThanOrEqual(RESOURCE_CEILING_CONTINUATION_MAX_ROUNDS_PER_WINDOW);
  });

  it("mixes correctly — only the barren rounds count", async () => {
    const r = await countUnproductiveResourceCeilingContinuationRounds(
      stubDb(["r1", "r2", "r3", "r4", "r5", "r6"], ["r2", "r5"]), input);
    expect(r).toEqual({ unproductive: 4, granted: 6, productive: 2 });
  });

  it("ignores progress rows with a null runId rather than miscounting them", async () => {
    const r = await countUnproductiveResourceCeilingContinuationRounds(
      stubDb(["r1", "r2"], [null as unknown as string, "r1"]), input);
    expect(r).toEqual({ unproductive: 1, granted: 2, productive: 1 });
  });

  it("samples well past the cap so a long productive card is judged on all its rounds", () => {
    // The plain counter may stop at cap+1; a progress-aware one must not, or a
    // card with many productive rounds would be capped on the first few rows.
    expect(RESOURCE_CEILING_CONTINUATION_PROGRESS_SAMPLE_LIMIT)
      .toBeGreaterThan(RESOURCE_CEILING_CONTINUATION_MAX_ROUNDS_PER_WINDOW * 2);
  });
});
