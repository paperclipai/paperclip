export const ISSUE_DETAIL_NAVIGATE_MARK = "issue-detail:navigate";
export const ISSUE_DETAIL_HEADER_PAINT_MARK = "issue-detail:header-paint";
export const ISSUE_DETAIL_CONTENT_PAINT_MARK = "issue-detail:content-paint";
export const ISSUE_DETAIL_HEADER_MEASURE = "issue-detail:navigate→header-paint";
export const ISSUE_DETAIL_CONTENT_MEASURE = "issue-detail:navigate→content-paint";

let issueDetailNavigationGeneration = 0;

declare global {
  interface Window {
    __PAPERCLIP_ISSUE_DETAIL_NAVIGATE_START__?: number;
  }
}

function supportsPerformanceMarks(): boolean {
  return typeof window !== "undefined" && typeof performance !== "undefined" && typeof performance.mark === "function";
}

export function beginIssueDetailNavigation(): void {
  issueDetailNavigationGeneration += 1;
  if (!supportsPerformanceMarks()) return;

  performance.clearMarks(ISSUE_DETAIL_NAVIGATE_MARK);
  performance.clearMarks(ISSUE_DETAIL_HEADER_PAINT_MARK);
  performance.clearMarks(ISSUE_DETAIL_CONTENT_PAINT_MARK);
  performance.clearMeasures(ISSUE_DETAIL_HEADER_MEASURE);
  performance.clearMeasures(ISSUE_DETAIL_CONTENT_MEASURE);

  const externallyCapturedStart = window.__PAPERCLIP_ISSUE_DETAIL_NAVIGATE_START__;
  delete window.__PAPERCLIP_ISSUE_DETAIL_NAVIGATE_START__;
  performance.mark(ISSUE_DETAIL_NAVIGATE_MARK, {
    startTime: typeof externallyCapturedStart === "number" ? externallyCapturedStart : performance.now(),
  });
}

export function scheduleIssueDetailPaintMeasure(
  markName: typeof ISSUE_DETAIL_HEADER_PAINT_MARK | typeof ISSUE_DETAIL_CONTENT_PAINT_MARK,
  measureName: typeof ISSUE_DETAIL_HEADER_MEASURE | typeof ISSUE_DETAIL_CONTENT_MEASURE,
): void {
  if (!supportsPerformanceMarks() || performance.getEntriesByName(measureName).length > 0) return;

  const navigationGeneration = issueDetailNavigationGeneration;
  requestAnimationFrame(() => {
    if (navigationGeneration !== issueDetailNavigationGeneration) return;
    requestAnimationFrame(() => {
      if (navigationGeneration !== issueDetailNavigationGeneration) return;
      if (performance.getEntriesByName(measureName).length > 0) return;
      if (performance.getEntriesByName(ISSUE_DETAIL_NAVIGATE_MARK).length === 0) {
        performance.mark(ISSUE_DETAIL_NAVIGATE_MARK);
      }
      performance.mark(markName);
      performance.measure(measureName, ISSUE_DETAIL_NAVIGATE_MARK, markName);
    });
  });
}

type VitalMetric = {
  name: "TTFB" | "LCP" | "INP";
  value: number;
};

function reportVital(metric: VitalMetric): void {
  console.info("[issue-detail:web-vital]", metric);
}

export function reportIssueDetailWebVitals(): () => void {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return () => undefined;

  const observers: PerformanceObserver[] = [];
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (navigation) {
    reportVital({ name: "TTFB", value: navigation.responseStart - navigation.requestStart });
  }

  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const latest = list.getEntries().at(-1);
      if (latest) reportVital({ name: "LCP", value: latest.startTime });
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
    observers.push(lcpObserver);
  } catch {}

  try {
    let longestInteraction = 0;
    const inpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const interactionEntry = entry as PerformanceEventTiming & { interactionId?: number };
        if (!interactionEntry.interactionId) continue;
        longestInteraction = Math.max(longestInteraction, interactionEntry.duration);
      }
      if (longestInteraction > 0) reportVital({ name: "INP", value: longestInteraction });
    });
    inpObserver.observe({ type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
    observers.push(inpObserver);
  } catch {}

  return () => observers.forEach((observer) => observer.disconnect());
}
