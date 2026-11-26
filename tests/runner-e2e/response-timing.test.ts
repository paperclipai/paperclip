import type { Page } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { armResponseTiming } from "./response-timing.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("starts observation before dispatch and drains without overlapping reads on teardown", async () => {
  vi.useFakeTimers();
  const absent = { response: false, acknowledgement: false };
  let complete: (value: typeof absent) => void = () => {};
  const read = vi.fn().mockImplementationOnce(() => new Promise<typeof absent>(resolve => { complete = resolve; }))
    .mockResolvedValue(absent);
  const locator = { getByTestId: () => locator, evaluateAll: read };
  const timing = armResponseTiming({ page: locator as unknown as Page });
  expect(read).toHaveBeenCalledTimes(1); // No dispatch or awaited acknowledgement yet.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stopping = timing.stop().then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(500);
  expect(stopped).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  complete(absent);
  await stopping;
  expect(stopped).toBe(true);
  // One final read after draining the in-flight request, then no more ticks.
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(["pending", "final"])("bounds shutdown when the %s read never returns and ignores late completions", async phase => {
  vi.useFakeTimers();
  const absent = { response: false, acknowledgement: false };
  let complete!: (value: typeof absent) => void;
  const stuck = () => new Promise<typeof absent>(resolve => { complete = resolve; });
  const read = phase === "pending" ? vi.fn(stuck) : vi.fn().mockResolvedValueOnce(absent).mockImplementation(stuck);
  const locator = { getByTestId: () => locator, evaluateAll: read };
  const timing = armResponseTiming({ page: locator as unknown as Page, acknowledgementTarget: { operator: "<=", ms: 2_000 } });
  await vi.advanceTimersByTimeAsync(0);
  const stopping = timing.stop();
  await vi.advanceTimersByTimeAsync(1_000);
  await stopping;
  const evidence = timing.results();
  for (const probe of evidence.filter(probe => probe.event !== "final_settlement")) {
    expect(probe).toMatchObject({ verdict: "inconclusive", firstPresentMs: null, observationFailures: 1, observationTimeouts: 1 });
    expect(probe.lastAbsentMs).toBe(phase === "pending" ? null : 0);
  }
  expect(read).toHaveBeenCalledTimes(phase === "pending" ? 1 : 2);
  complete({ response: true, acknowledgement: true });
  await vi.advanceTimersByTimeAsync(1_000);
  await timing.stop();
  await timing.observeResponse(locator as unknown as Page);
  expect(timing.results()).toEqual(evidence);
  expect(read).toHaveBeenCalledTimes(phase === "pending" ? 1 : 2);
  expect(vi.getTimerCount()).toBe(0);
});

it("observes edited visible text separately from a platform acknowledgement and final settlement", async () => {
  let clock = 0;
  let receipt = true;
  let text = "Platform receipt";
  let visible = true;
  vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: visible ? "visible" : "hidden" }));
  const element = {
    closest: () => ({ querySelector: () => receipt ? {} : null }),
    get textContent() { return text; },
    getClientRects: () => visible ? [{}] : [],
  };
  const locator = {
    getByTestId: () => locator,
    evaluateAll: async (read: (elements: Element[]) => unknown) => read([element as unknown as Element]),
  };
  const page = locator as unknown as Page;
  const timing = armResponseTiming({ now: () => clock });
  clock = 1_900;
  const firstSettlement = timing.beginSettlement();
  await timing.observeResponse(page);
  firstSettlement({ present: false });
  // The same message now has substantive content; creation time does not
  // change. Hidden content is still not a visible response.
  receipt = false;
  text = "The answer";
  visible = false;
  clock = 29_900;
  await timing.observeResponse(page);
  visible = true;
  clock = 30_100;
  await timing.observeResponse(page);
  clock = 52_965;
  const lastAbsent = timing.beginSettlement();
  clock = 53_000;
  lastAbsent({ present: false });
  const present = timing.beginSettlement();
  clock = 53_334;
  present({ present: true });
  expect(timing.results()).toMatchObject([
    { event: "first_visible_response", verdict: "inconclusive", lastAbsentMs: 29_900, firstPresentMs: 30_100, resolutionMs: 1 },
    { event: "final_settlement", verdict: "fail", lastAbsentMs: 52_965, firstPresentMs: 53_334 },
  ]);
});

it("uses the same observation bounds for an explicitly expected acknowledgement", async () => {
  let clock = 0;
  let acknowledgement = false;
  const read = vi.fn(async () => ({ response: false, acknowledgement }));
  const locator = { getByTestId: () => locator, evaluateAll: read };
  const timing = armResponseTiming({ now: () => clock, acknowledgementTarget: { operator: "<=", ms: 2_000 } });
  clock = 1_901;
  await timing.observeResponse(locator as unknown as Page);
  clock = 2_427;
  acknowledgement = true;
  await timing.observeResponse(locator as unknown as Page);
  expect(read).toHaveBeenCalledTimes(2); // One snapshot per poll shared by both events.
  expect(timing.results().find(probe => probe.event === "acknowledgement")).toMatchObject({
    verdict: "inconclusive", lastAbsentMs: 1_901, firstPresentMs: 2_427,
    interval: { lower: { ms: 1_900, inclusive: false }, upper: { ms: 2_428, inclusive: true } },
  });
});
