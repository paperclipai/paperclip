import { describe, expect, it } from "vitest";
import type { PageContentGateSnapshot } from "./page-content-gates";
import { createPageLoadRecorder, type PageLoadMeasurement, type PageLoadSink } from "./page-load-recorder";

function createHarness() {
  let time = 0;
  let frames: Array<() => void> = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;
  const state = {
    pendingData: false,
    hidden: false,
    view: null as string | null,
    gates: { blockingCount: 0, contentCount: 0, pendingContentCount: 0, lastContentReadyAt: null } as PageContentGateSnapshot,
  };
  const recorder = createPageLoadRecorder({
    now: () => time,
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {
      frames = [];
    },
    setTimer: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: time + ms, callback });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    isDocumentHidden: () => state.hidden,
    hasPendingPrimaryData: () => state.pendingData,
    readGates: () => state.gates,
    readView: () => state.view,
  });
  const ended: PageLoadMeasurement[] = [];
  const begun: PageLoadMeasurement[] = [];
  const sink: PageLoadSink = {
    begin: (measurement) => begun.push({ ...measurement }),
    end: (measurement) => ended.push({ ...measurement }),
  };
  return {
    recorder,
    state,
    ended,
    begun,
    sink,
    /** Advance one 16 ms animation frame. */
    frame() {
      time += 16;
      const due = frames;
      frames = [];
      for (const callback of due) callback();
      for (const [id, timer] of timers) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    /** Move the clock without firing timers or frames, as a suspended computer does. */
    jump(ms: number) {
      time += ms;
    },
    advance(ms: number) {
      time += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    get time() {
      return time;
    },
  };
}

describe("createPageLoadRecorder", () => {
  it("ends a client navigation at the first of two idle frames once primary data has loaded", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.advance(1000);
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/:companyPrefix/issues", loadType: "client", startTime: 990 });
    expect(harness.begun).toHaveLength(1);

    harness.frame();
    harness.frame();
    harness.state.pendingData = false;
    harness.frame(); // first idle frame, t=1048
    expect(harness.ended).toHaveLength(0);
    harness.frame();

    expect(harness.ended).toEqual([expect.objectContaining({
      routeTemplate: "/:companyPrefix/issues",
      loadType: "client",
      startTime: 990,
      endTime: 1048,
      outcome: "ready",
      readySignal: "idle",
      wasHidden: false,
    })]);
  });

  it("waits for blocking gates and uses the content gate paint time when a page declares one", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.recorder.begin({ routeTemplate: "/:companyPrefix/issues/:issueId", loadType: "client", startTime: 0 });
    harness.state.gates = { blockingCount: 1, contentCount: 0, pendingContentCount: 0, lastContentReadyAt: null };
    harness.frame();
    harness.frame();
    expect(harness.ended).toHaveLength(0);

    // Network idle alone does not end a page that declared a content gate.
    harness.state.gates = { blockingCount: 0, contentCount: 1, pendingContentCount: 1, lastContentReadyAt: null };
    harness.frame();
    harness.frame();
    expect(harness.ended).toHaveLength(0);

    harness.state.gates = { blockingCount: 0, contentCount: 1, pendingContentCount: 0, lastContentReadyAt: 70 };
    harness.frame();
    harness.frame();
    expect(harness.ended[0]).toMatchObject({ endTime: 70, outcome: "ready", readySignal: "content" });
  });

  it("interrupts an open measurement when another navigation starts", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/a", loadType: "client", startTime: 0 });
    harness.advance(100);
    harness.recorder.begin({ routeTemplate: "/b", loadType: "client", startTime: 100 });
    expect(harness.ended[0]).toMatchObject({ routeTemplate: "/a", outcome: "interrupted", endTime: 100 });
    expect(harness.recorder.open()?.routeTemplate).toBe("/b");
  });

  it("ends an interrupted measurement where the next one starts, so their windows never overlap", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/a", loadType: "client", startTime: 0 });
    harness.advance(250);
    // The router commits after the history change that started the navigation.
    harness.recorder.begin({ routeTemplate: "/b", loadType: "client", startTime: 200 });
    expect(harness.ended[0]).toMatchObject({ routeTemplate: "/a", outcome: "interrupted", endTime: 200 });
  });

  it("continues a measurement through a redirect under the new route", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/", loadType: "hard", startTime: 0 });
    expect(harness.recorder.redirect("/:companyPrefix/dashboard")).toBe(true);
    harness.state.pendingData = false;
    harness.frame();
    harness.frame();
    expect(harness.ended).toEqual([expect.objectContaining({ routeTemplate: "/:companyPrefix/dashboard", loadType: "hard", startTime: 0 })]);
    expect(harness.recorder.hardLoadRouteTemplate()).toBe("/:companyPrefix/dashboard");
  });

  it("times out a page that never finishes loading", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/slow", loadType: "client", startTime: 0 });
    harness.advance(30_000);
    expect(harness.ended[0]).toMatchObject({ outcome: "timeout", endTime: 30_000, readySignal: null });
  });

  it("ends a measurement as hidden, at the moment the tab hid, instead of waiting for frames that never come", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/a", loadType: "client", startTime: 0 });
    harness.advance(400);
    harness.state.hidden = true;
    harness.recorder.noteHidden(400);
    expect(harness.ended).toEqual([expect.objectContaining({ outcome: "hidden", endTime: 400, readySignal: null, wasHidden: true })]);
    harness.advance(30_000);
    expect(harness.ended).toHaveLength(1);
  });

  it("ends a load that starts in a hidden tab immediately as hidden, never as a 30 s timeout", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.hidden = true;
    harness.state.pendingData = true;
    harness.advance(900);
    harness.recorder.begin({ routeTemplate: "/", loadType: "hard", startTime: 0, hiddenAt: 0 });
    expect(harness.ended).toEqual([expect.objectContaining({ outcome: "hidden", endTime: 0, loadType: "hard" })]);
    harness.advance(30_000);
    expect(harness.ended).toHaveLength(1);
  });

  it("ends a hard load that was hidden before tracing started at the time it hid", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.advance(900);
    // Visible again by now, but rendering was paused while it was hidden.
    harness.recorder.begin({ routeTemplate: "/a", loadType: "hard", startTime: 0, hiddenAt: 350 });
    expect(harness.ended[0]).toMatchObject({ outcome: "hidden", endTime: 350 });
  });

  it("keeps a redirect after a hidden hard load on the same measurement", () => {
    const harness = createHarness();
    harness.state.hidden = true;
    harness.recorder.begin({ routeTemplate: "/", loadType: "hard", startTime: 0, hiddenAt: 0 });
    expect(harness.recorder.redirect("/:companyPrefix/dashboard")).toBe(true);
    harness.recorder.attachSink(harness.sink);
    expect(harness.ended).toEqual([expect.objectContaining({ routeTemplate: "/:companyPrefix/dashboard", outcome: "hidden" })]);
    expect(harness.recorder.hardLoadRouteTemplate()).toBe("/:companyPrefix/dashboard");
  });

  it("ends a timeout at start + timeout however late the timer fires, and marks a suspend", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/slow", loadType: "hard", startTime: 0 });
    // The computer slept: the 30 s timer fires about two hours later.
    harness.advance(7_758_250);
    expect(harness.ended).toEqual([expect.objectContaining({ outcome: "timeout", endTime: 30_000, suspended: true })]);
  });

  it("does not mark an ordinarily late timeout as suspended", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/slow", loadType: "client", startTime: 0 });
    harness.advance(30_400);
    expect(harness.ended[0]).toMatchObject({ outcome: "timeout", endTime: 30_000, suspended: false });
  });

  it("reports a load that only became ready after the deadline, across a suspend, as a capped timeout", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/a", loadType: "client", startTime: 0 });
    harness.frame();
    harness.jump(2 * 60 * 60 * 1000);
    harness.state.pendingData = false;
    // Frames resume before the overdue timer runs.
    harness.frame();
    harness.frame();
    expect(harness.ended).toEqual([expect.objectContaining({ outcome: "timeout", endTime: 30_000, readySignal: null, suspended: true })]);
  });

  it("marks a ready load that spanned a suspend shorter than the timeout", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/a", loadType: "client", startTime: 0 });
    harness.frame();
    harness.jump(20_000);
    harness.state.pendingData = false;
    harness.frame();
    harness.frame();
    expect(harness.ended[0]).toMatchObject({ outcome: "ready", suspended: true });
  });

  it("records the page view, read again when the measurement ends", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.view = "default";
    harness.recorder.begin({ routeTemplate: "/:companyPrefix/issues", loadType: "hard", startTime: 0 });
    expect(harness.begun[0]).toMatchObject({ view: "default" });
    // The page writes the resolved view into the URL while loading.
    harness.state.view = "mine";
    harness.frame();
    harness.frame();
    expect(harness.ended[0]).toMatchObject({ view: "mine", suspended: false });
  });

  it("keeps the view an interrupted measurement had, not the next page's", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.state.pendingData = true;
    harness.state.view = "mine";
    harness.recorder.begin({ routeTemplate: "/:companyPrefix/issues", loadType: "client", startTime: 0 });
    harness.state.view = null;
    harness.recorder.begin({ routeTemplate: "/b", loadType: "client", startTime: 10 });
    expect(harness.ended[0]).toMatchObject({ outcome: "interrupted", view: "mine" });
  });

  it("buffers measurements that finish before the SDK attaches and replays them in order", () => {
    const harness = createHarness();
    harness.recorder.begin({ routeTemplate: "/hard", loadType: "hard", startTime: 0 });
    harness.frame();
    harness.frame();
    harness.state.pendingData = true;
    harness.recorder.begin({ routeTemplate: "/open", loadType: "client", startTime: 40 });
    expect(harness.ended).toHaveLength(0);

    harness.recorder.attachSink(harness.sink);
    expect(harness.begun.map((m) => m.routeTemplate)).toEqual(["/hard", "/open"]);
    expect(harness.ended.map((m) => m.routeTemplate)).toEqual(["/hard"]);
    expect(harness.begun[1]!.endTime).toBeNull();
  });

  it("does nothing after stop", () => {
    const harness = createHarness();
    harness.recorder.attachSink(harness.sink);
    harness.recorder.stop();
    harness.recorder.begin({ routeTemplate: "/a", loadType: "client", startTime: 0 });
    harness.frame();
    harness.frame();
    expect(harness.begun).toHaveLength(0);
    expect(harness.ended).toHaveLength(0);
  });
});
