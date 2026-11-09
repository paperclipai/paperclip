// Task-open click harness for real instances (staging, production, local).
//
// Paste into DevTools (or run via a browser automation tool) on an Issues list
// page such as /<company>/issues?view=mine, then call:
//
//   await __taskOpenHarness.measure("ABC-123")          // click the row, time it
//   await __taskOpenHarness.series(["ABC-1", "ABC-2"])  // back to the list between samples
//
// Each sample starts at the row click and records, on every animation frame:
//   composerVisible  the composer input is rendered and not concealed
//   latestVisible    the last conversation message is visible in the viewport
//   threadMounted    the chat thread element exists
//   settled          3 s without the latest message changing or moving
// plus layout shifts, moves of the latest message after it first appeared, and
// every request started after the click with its server time (Server-Timing).
//
// The summary strips query values and ids, so it is safe to paste into an issue
// or PR. It reads only what the browser already received; nothing is sent.
(() => {
  const visible = (el) =>
    Boolean(el && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().height > 0);
  const inViewport = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight && rect.height > 0;
  };
  const scrub = (url) =>
    url
      .replace(location.origin, "")
      .replace(/\?.*$/, (query) => `?${[...new URLSearchParams(query.slice(1)).keys()].join("&")}`)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>");
  const serverMs = (entry) => {
    const metric = (entry.serverTiming || []).find((timing) => timing.name === "paperclip_api");
    return metric ? Math.round(metric.duration) : null;
  };

  async function measure(issueRef, { timeoutMs = 20_000, quietMs = 3_000 } = {}) {
    performance.setResourceTimingBufferSize(10_000);
    const link = document.querySelector(`a[href$="/issues/${issueRef}"]`);
    if (!link) throw new Error(`No visible row link for ${issueRef}`);
    const shifts = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) shifts.push(entry);
    });
    observer.observe({ type: "layout-shift", buffered: false });
    const marks = {};
    const latestChanges = [];
    const latestMoves = [];
    let latestKey = null;
    let latestTop = null;
    const t0 = performance.now();
    link.click();
    await new Promise((resolve) => {
      const tick = () => {
        const t = performance.now() - t0;
        const thread = document.querySelector("[data-testid=task-chat-thread]");
        if (marks.threadMounted === undefined && thread) marks.threadMounted = t;
        const composer = document.querySelector("[data-testid=task-chat-composer-input]");
        if (marks.composerVisible === undefined && visible(composer)) marks.composerVisible = t;
        const messages = document.querySelectorAll("[data-conversation-message]");
        const latest = messages[messages.length - 1];
        if (latest && visible(latest) && inViewport(latest)) {
          if (marks.latestVisible === undefined) marks.latestVisible = t;
          const key = `${messages.length}|${(latest.textContent || "").slice(0, 80)}`;
          if (key !== latestKey) {
            latestChanges.push(Math.round(t));
            latestKey = key;
            latestTop = null;
          }
          const top = latest.getBoundingClientRect().top;
          if (latestTop !== null && Math.abs(top - latestTop) > 2) latestMoves.push({ t: Math.round(t), dy: Math.round(top - latestTop) });
          latestTop = top;
        }
        const lastEvent = Math.max(latestChanges.at(-1) ?? 0, latestMoves.at(-1)?.t ?? 0);
        if (marks.composerVisible !== undefined && marks.latestVisible !== undefined && t - lastEvent > quietMs) {
          marks.settled = t;
          return resolve();
        }
        if (t > timeoutMs) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    observer.disconnect();
    const ready = Math.max(marks.composerVisible ?? Infinity, marks.latestVisible ?? Infinity);
    const requests = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.startTime >= t0 - 5 && entry.name.includes("/api/"))
      .map((entry) => ({
        url: scrub(entry.name),
        start: Math.round(entry.startTime - t0),
        duration: Math.round(entry.duration),
        serverMs: serverMs(entry),
      }));
    const beforeReady = requests.filter((request) => request.start < ready);
    const counts = {};
    for (const request of requests) counts[request.url] = (counts[request.url] ?? 0) + 1;
    return {
      issueRef,
      marks: Object.fromEntries(Object.entries(marks).map(([key, value]) => [key, Math.round(value)])),
      cls: Number(shifts.reduce((sum, entry) => sum + entry.value, 0).toFixed(4)),
      latestMoves,
      requests: { total: requests.length, beforeReady: beforeReady.length },
      releasedBy: beforeReady
        .filter((request) => request.start + request.duration > ready - 250)
        .sort((a, b) => b.start + b.duration - (a.start + a.duration))
        .slice(0, 3),
      slowest: [...requests].sort((a, b) => b.duration - a.duration).slice(0, 5),
      repeated: Object.entries(counts).filter(([, count]) => count > 1).map(([url, count]) => `${url} x${count}`),
    };
  }

  async function series(issueRefs, options = {}) {
    const listUrl = location.pathname + location.search;
    const samples = [];
    for (const issueRef of issueRefs) {
      if (location.pathname + location.search !== listUrl) {
        history.back();
        await new Promise((resolve) => setTimeout(resolve, options.listSettleMs ?? 3_000));
      }
      samples.push(await measure(issueRef, options));
    }
    return samples;
  }

  window.__taskOpenHarness = { measure, series };
})();
