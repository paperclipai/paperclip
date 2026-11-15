import type { Page } from "@playwright/test";
import { armLatencyProbe, type LatencyTarget } from "./latency-timing.js";

/** Browser observations, independent of provider creation/edit timestamps and run settlement.
 * Used only by the explicit latency diagnostic; these are not Slack delivery probes. */
export function armResponseTiming(input: { now?: () => number; page?: Page; acknowledgementTarget?: LatencyTarget } = {}) {
  const common = { now: input.now, resolutionMs: 1 };
  const response = armLatencyProbe({ ...common, event: "first_visible_response", target: { operator: "<=", ms: 30_000 } });
  const settlement = armLatencyProbe({ ...common, event: "final_settlement", target: { operator: "<=", ms: 30_000 } });
  // Only measure acknowledgement when the caller expects that feature. The
  // Daytona response diagnostic does not enable receipts or measure Slack.
  const acknowledgement = input.acknowledgementTarget
    ? armLatencyProbe({ ...common, event: "acknowledgement", target: input.acknowledgementTarget }) : undefined;
  const shutdown = new AbortController();
  const timeouts = new Map<ReturnType<typeof armLatencyProbe>, number>();
  let stopped = false;
  const observeResponse = async (page: Page) => {
    if (stopped || shutdown.signal.aborted) return;
    const observing = [response, ...(acknowledgement ? [acknowledgement] : [])]
      .filter(probe => probe.result().firstPresentMs === null);
    if (!observing.length) return;
    const read = () => page.getByTestId("task-chat-thread")
      .getByTestId("task-chat-agent-bubble").evaluateAll(elements => {
        const visible = { response: false, acknowledgement: false };
        for (const element of elements) {
          // Receipt details live beside the bubble inside its thread anchor.
          // A platform receipt is not the agent's first substantive response.
          const anchor = element.closest("[data-thread-anchor]");
          const receipt = anchor?.querySelector('[aria-label="Message details"]');
          const style = getComputedStyle(element);
          if (element.textContent?.trim() && element.getClientRects().length > 0
            && style.visibility !== "hidden" && style.display !== "none") {
            if (receipt) visible.acknowledgement = true;
            else visible.response = true;
          }
        }
        return visible;
      });
    let resolve!: (value: Awaited<ReturnType<typeof read>>) => void;
    let reject!: (error: unknown) => void;
    const snapshot = new Promise<Awaited<ReturnType<typeof read>>>((yes, no) => { resolve = yes; reject = no; });
    // Both lower observations must precede the shared read, including the
    // second probe. Starting that probe after read() could overstate absence.
    const samples = Promise.all([
      response.sample(async () => ({ present: (await snapshot).response })),
      acknowledgement?.sample(async () => ({ present: (await snapshot).acknowledgement })),
    ]);
    const abandon = () => {
      for (const probe of observing) timeouts.set(probe, (timeouts.get(probe) ?? 0) + 1);
      // Reject the shared snapshot so a late browser completion cannot alter
      // evidence after cleanup resumes. The browser operation itself may still
      // be running; do not start another read after this deadline.
      reject(new Error("Latency observer shutdown deadline exceeded"));
    };
    shutdown.signal.addEventListener("abort", abandon, { once: true });
    try {
      try { read().then(resolve, reject); } catch (error) { reject(error); }
      await samples;
    } finally {
      shutdown.signal.removeEventListener("abort", abandon);
    }
  };
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  if (input.page) {
    const page = input.page;
    const tick = () => {
      if (pending) return;
      // A failed browser read is counted by the probe, never recorded as absence.
      pending = observeResponse(page).catch(() => {}).finally(() => {
        pending = undefined;
        if (response.result().firstPresentMs !== null
          && (!acknowledgement || acknowledgement.result().firstPresentMs !== null)) clearInterval(timer);
      });
    };
    tick(); // The first read starts before dispatch, not after its acknowledgement.
    timer = setInterval(tick, 100);
  }
  return {
    beginSettlement: () => settlement.beginObservation(),
    observeResponse,
    stop() {
      return stopping ??= (async () => {
        clearInterval(timer);
        // One deadline covers both draining and the final observation. Abort
        // only our snapshot wait, leaving page teardown to the fixture owner.
        const deadline = setTimeout(() => shutdown.abort(), 1_000);
        try {
          await pending;
          if (input.page) await observeResponse(input.page).catch(() => {});
        } finally {
          stopped = true;
          clearTimeout(deadline);
        }
      })();
    },
    results: () => [response, settlement, ...(acknowledgement ? [acknowledgement] : [])].map(probe => ({
      ...probe.result(), ...(timeouts.has(probe) ? { observationTimeouts: timeouts.get(probe)! } : {}),
    })),
  };
}
