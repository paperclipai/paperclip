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
//   settled          3 s without the latest message changing, growing or moving
// plus layout shifts, moves of the latest message after it first appeared, and
// every API request started after the click with its server time (Server-Timing).
// A fetch that is still running when the sample ends is reported with
// `pending: true` and the time it has run so far.
//
// The summary labels each sample ("sample 1", ...) instead of the task
// reference. In request paths it replaces query values and every path segment
// that contains a digit (UUIDs, task references, numeric ids) with a
// placeholder. Review the output before you share it: other path segments,
// such as a company prefix, can stay. The harness reads only what the browser
// already received; nothing is sent.
(() => {
  const visible = (el) =>
    Boolean(el && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().height > 0);
  const inViewport = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight && rect.height > 0;
  };
  const scrub = (url) => {
    const parsed = new URL(url, location.href);
    const path = parsed.pathname
      .split("/")
      .map((segment) => (/\d/.test(segment) ? "<id>" : segment))
      .join("/");
    const keys = [...parsed.searchParams.keys()];
    return keys.length > 0 ? `${path}?${keys.join("&")}` : path;
  };
  const isApi = (url) => new URL(url, location.href).pathname.includes("/api/");
  const serverMs = (entry) => {
    const metric = (entry.serverTiming || []).find((timing) => timing.name === "paperclip_api");
    return metric ? Math.round(metric.duration) : null;
  };

  let sampleCount = 0;

  async function measure(issueRef, { timeoutMs = 20_000, quietMs = 3_000, label } = {}) {
    performance.setResourceTimingBufferSize(10_000);
    const link = document.querySelector(`a[href$="/issues/${issueRef}"]`);
    if (!link) throw new Error(`No visible row link for ${issueRef}`);
    sampleCount += 1;
    const sample = label ?? `sample ${sampleCount}`;
    const shifts = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) shifts.push(entry);
    });
    observer.observe({ type: "layout-shift", buffered: false });
    const marks = {};
    const latestChanges = [];
    const latestMoves = [];
    let latestKey = null;
    let latestElement = null;
    let latestTop = null;
    // Resource Timing has no entry for a request that is still running, so
    // record fetch starts too. In-flight fetches are reported as pending.
    const fetches = [];
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const record = { url, start: performance.now(), done: false };
      fetches.push(record);
      const result = originalFetch.call(this, input, init);
      const finish = () => {
        record.done = true;
      };
      result.then(finish, finish);
      return result;
    };
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
          // Text appended to a live message, or a message that grows in place,
          // counts as a change, so `settled` waits for the output to stop.
          const rect = latest.getBoundingClientRect();
          const text = latest.textContent || "";
          const key = `${messages.length}|${text.length}|${text.slice(-80)}|${Math.round(rect.height)}`;
          if (key !== latestKey) {
            latestChanges.push(Math.round(t));
            latestKey = key;
          }
          // Compare positions only for the same message element. A message
          // that grows upward while the chat stays pinned to the bottom is a
          // move; a different latest message starts a new position baseline.
          if (latest !== latestElement) {
            latestElement = latest;
            latestTop = null;
          }
          const top = rect.top;
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
    window.fetch = originalFetch;
    const end = performance.now();
    const ready = Math.max(marks.composerVisible ?? Infinity, marks.latestVisible ?? Infinity);
    const completed = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.startTime >= t0 - 5 && isApi(entry.name))
      .map((entry) => ({
        url: scrub(entry.name),
        start: Math.round(entry.startTime - t0),
        duration: Math.round(entry.duration),
        serverMs: serverMs(entry),
      }));
    const pending = fetches
      .filter((record) => !record.done && isApi(record.url))
      .map((record) => ({
        url: scrub(record.url),
        start: Math.round(record.start - t0),
        duration: Math.round(end - record.start),
        serverMs: null,
        pending: true,
      }));
    const requests = [...completed, ...pending];
    const beforeReady = requests.filter((request) => request.start < ready);
    const counts = {};
    for (const request of requests) counts[request.url] = (counts[request.url] ?? 0) + 1;
    return {
      sample,
      marks: Object.fromEntries(Object.entries(marks).map(([key, value]) => [key, Math.round(value)])),
      cls: Number(shifts.reduce((sum, entry) => sum + entry.value, 0).toFixed(4)),
      latestMoves,
      requests: { total: requests.length, beforeReady: beforeReady.length, pending: pending.length },
      // Requests that finished in the 250 ms before the page was ready. A
      // request that finished after that point did not release the reveal.
      releasedBy: completed
        .filter((request) => request.start < ready)
        .filter((request) => request.start + request.duration > ready - 250 && request.start + request.duration <= ready)
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
