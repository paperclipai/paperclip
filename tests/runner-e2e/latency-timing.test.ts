import { describe, expect, it } from "vitest";
import { armLatencyProbe, classifyLatency, observationTiming } from "./latency-timing.js";

const target = { operator: "<=" as const, ms: 2_000 };
const observed = (lastAbsentMs: number | null, firstPresentMs: number | null, resolutionMs: number | null = 0) =>
  observationTiming({ event: "acknowledgement", lastAbsentMs, firstPresentMs, resolutionMs });

describe("interval latency classification", () => {
  it("retains the historical acknowledgement bounds as inconclusive", () => {
    expect(classifyLatency(observed(1_901, 2_427), target)).toMatchObject({
      verdict: "inconclusive", lastAbsentMs: 1_901, firstPresentMs: 2_427,
      interval: { lower: { ms: 1_901, inclusive: false }, upper: { ms: 2_427, inclusive: true } },
    });
    expect(classifyLatency({ ...observed(52_965, 53_334), event: "first_visible_response" }, { operator: "<=", ms: 30_000 }).verdict).toBe("fail");
  });

  it.each(["<", "<="] as const)("classifies every endpoint equality for %s", operator => {
    // The same number is not sufficient: endpoint inclusion determines equality.
    for (const lowerInclusive of [false, true]) for (const upperInclusive of [false, true]) {
      const verdict = (lower: number, upper: number) => classifyLatency({
        ...observed(null, null), interval: {
          lower: { ms: lower, inclusive: lowerInclusive }, upper: { ms: upper, inclusive: upperInclusive },
        },
      }, { operator, ms: 2_000 }).verdict;
      expect(verdict(1_000, 2_000)).toBe(operator === "<=" || !upperInclusive ? "pass" : "inconclusive");
      expect(verdict(2_000, 3_000)).toBe(operator === "<" || !lowerInclusive ? "fail" : "inconclusive");
      expect(verdict(1_999, 2_001)).toBe("inconclusive");
      expect(verdict(2_000, 2_000)).toBe(lowerInclusive && upperInclusive ? (operator === "<=" ? "pass" : "fail") : "inconclusive");
    }
  });

  it.each([
    [null, null, "inconclusive"], [null, 1_999, "pass"], [null, 2_001, "inconclusive"],
    [1_999, null, "inconclusive"], [2_000, null, "fail"], [2_001, null, "fail"],
  ] as const)("handles missing observations (%s, %s)", (lower, upper, verdict) => {
    const result = classifyLatency(observed(lower, upper), target);
    expect(result.verdict).toBe(verdict);
    expect(result.lastAbsentMs).toBe(lower);
    expect(result.firstPresentMs).toBe(upper);
  });

  it.each([
    [-1, 1_000], [NaN, 1_000], [1_000, Infinity], [2_001, 2_000], [2_000, 2_000],
  ])("does not turn invalid observations %s, %s into exact latency", (lower, upper) => {
    expect(classifyLatency(observed(lower!, upper!), target)).toMatchObject({ verdict: "inconclusive", reason: "invalid_evidence" });
  });

  it("keeps unknown resolution and widens rounded measurements before grading", () => {
    expect(classifyLatency(observed(1_900, 2_000, null), target).verdict).toBe("inconclusive");
    expect(classifyLatency(observed(1_900, 2_000, 1), target)).toMatchObject({
      verdict: "inconclusive", resolutionMs: 1, firstPresentMs: 2_000,
      interval: { lower: { ms: 1_899 }, upper: { ms: 2_001 } },
    });
    expect(classifyLatency(observed(0, 1, 1), { operator: "<=", ms: 0 }).verdict).toBe("inconclusive");
    for (const resolution of [-1, NaN, Infinity]) expect(classifyLatency(observed(1, 2, resolution), target).reason).toBe("invalid_evidence");
    for (const ms of [-1, NaN, Infinity]) expect(classifyLatency(observed(1, 2), { ...target, ms }).reason).toBe("invalid_evidence");
  });

  it("matches an independent finite-domain oracle on strict and inclusive targets", () => {
    for (const operator of ["<", "<="] as const) for (const lowerInclusive of [false, true]) for (const upperInclusive of [false, true]) {
      for (let lower = 0; lower <= 4; lower++) for (let upper = lower; upper <= 4; upper++) {
        const values = Array.from({ length: 9 }, (_, n) => n / 2)
          .filter(n => (n > lower || (lowerInclusive && n === lower)) && (n < upper || (upperInclusive && n === upper)));
        const passes = values.map(n => operator === "<" ? n < 2 : n <= 2);
        const expected = !values.length ? "inconclusive" : passes.every(Boolean) ? "pass" : passes.every(p => !p) ? "fail" : "inconclusive";
        const interval = { lower: { ms: lower, inclusive: lowerInclusive }, upper: { ms: upper, inclusive: upperInclusive } };
        expect(classifyLatency({ ...observed(null, null), interval }, { operator, ms: 2 }).verdict).toBe(expected);
      }
    }
  });
});

describe("monotonic observation probes", () => {
  it("measures an edited message's first matching visibility independently of creation and settlement", async () => {
    let clock = 10_000;
    const now = () => clock;
    const reply = armLatencyProbe({ event: "first_visible_response", target, resolutionMs: 0, now });
    const settled = armLatencyProbe({ event: "final_settlement", target, resolutionMs: 0, now });
    // The observer is armed before dispatch; the response can arrive before send returns.
    const send = async () => {
      clock += 1_901;
      await reply.sample(async () => ({ present: false }));
      clock = 12_427;
      await reply.sample(async () => ({ present: true, messageTimestamps: { createdAt: "2026-01-01T00:00:00Z", editedAt: "2026-01-01T00:00:10Z" } }));
    };
    await send();
    clock = 63_334;
    await reply.sample(async () => ({ present: false }));
    await settled.sample(async () => ({ present: true }));
    expect(reply.result()).toMatchObject({ event: "first_visible_response", verdict: "inconclusive", lastAbsentMs: 1_901, firstPresentMs: 2_427,
      messageTimestamps: { createdAt: "2026-01-01T00:00:00Z", editedAt: "2026-01-01T00:00:10Z" } });
    expect(settled.result()).toMatchObject({ event: "final_settlement", lastAbsentMs: null, firstPresentMs: 53_334 });
  });

  it("uses poll start for absence and poll completion for presence", async () => {
    let clock = 0;
    const probe = armLatencyProbe({ event: "acknowledgement", target, resolutionMs: 0, now: () => clock });
    clock = 1_901;
    await probe.sample(async () => { clock = 2_100; return { present: false }; });
    clock = 2_200;
    await probe.sample(async () => { clock = 2_427; return { present: true }; });
    expect(probe.result()).toMatchObject({ verdict: "inconclusive", lastAbsentMs: 1_901, firstPresentMs: 2_427 });
  });

  it("does not count failed reads as absence or use wall-clock message metadata", async () => {
    let clock = 0;
    const probe = armLatencyProbe({ event: "acknowledgement", target, resolutionMs: 0, now: () => clock });
    clock = 3_000;
    await expect(probe.sample(async () => { throw new Error("unavailable"); })).rejects.toThrow("unavailable");
    expect(probe.result()).toMatchObject({ verdict: "inconclusive", lastAbsentMs: null, firstPresentMs: null });
    await probe.sample(async () => ({ present: true, messageTimestamps: { createdAt: "invalid", editedAt: "2099-01-01" } }));
    expect(probe.result()).toMatchObject({ verdict: "inconclusive", firstPresentMs: 3_000 });
  });

  it("rejects a backwards clock instead of clamping latency to zero", async () => {
    let clock = 100;
    const probe = armLatencyProbe({ event: "acknowledgement", target, resolutionMs: 0, now: () => clock });
    clock = 99;
    await probe.sample(async () => ({ present: true }));
    expect(probe.result()).toMatchObject({ verdict: "inconclusive", reason: "invalid_evidence" });
  });
});
