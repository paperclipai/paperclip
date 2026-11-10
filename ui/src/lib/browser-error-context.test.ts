// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetPageDiagnostics,
  buildBrowserErrorContext,
  readPageLifecycle,
  sanitizeComponentStack,
  startPageDiagnostics,
  takeRejectionEventSnapshot,
} from "./browser-error-context";

afterEach(() => {
  __resetPageDiagnostics();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.className = "";
});

describe("browser error context", () => {
  it("keeps React component names without locations or unrecognized content", () => {
    const stack = `
    at TaskDetail (https://tenant.example/assets/app.js?token=private-value:42:7)
    at div (<anonymous>)
    in AppShell (created by Router)
TaskPanel@https://tenant.example/tasks/private-task:12:3
    at ErrorBoundary (/workspace/private/src/Boundary.tsx:15:9)
    at https://tenant.example/private-page:17:3
unrecognized private content`;
    expect(sanitizeComponentStack(stack)).toBe(
      "\n    at TaskDetail\n    at div\n    at AppShell\n    at TaskPanel\n    at ErrorBoundary",
    );
  });

  it("bounds malformed and oversized component stacks", () => {
    expect(sanitizeComponentStack(`    at ${"a".repeat(101)} (private)`)).toBeUndefined();
    expect(sanitizeComponentStack("x".repeat(16_384) + "\n    at SecretSuffix")).toBeUndefined();
    expect(sanitizeComponentStack("\n    at TaskDetail (private)".repeat(100))?.match(/at TaskDetail/g)).toHaveLength(40);
  });

  it.each([undefined, null, "", "private unrecognized data"])("omits absent or unrecognized stacks: %s", (stack) => {
    expect(sanitizeComponentStack(stack)).toBeUndefined();
  });

  it.each(["translated-ltr", "translated-rtl"])("records only a translation-marker boolean for %s", (marker) => {
    document.documentElement.className = `${marker} private-customer-class`;
    const result = buildBrowserErrorContext({ boundary: "route", componentStack: "\n    at TaskDetail" });
    expect(result).toMatchObject({
      tags: { react_error_boundary: "route" },
      contexts: { react: { componentStack: "\n    at TaskDetail" }, browser_state: { translation_marker: true } },
    });
    expect(JSON.stringify(result)).not.toContain("private-customer-class");
  });

  it("captures a snapshot rather than reading changed DOM state later", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
    const result = buildBrowserErrorContext({ boundary: "app" });
    document.documentElement.classList.add("translated-ltr");
    expect(result.contexts.browser_state).toEqual({
      ready_state: "interactive", visibility_state: "hidden", translation_marker: false,
    });
  });

  it("keeps the component trace when browser-state reads throw", () => {
    vi.spyOn(document, "readyState", "get").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(document.documentElement, "classList", "get").mockImplementation(() => { throw new Error("unavailable"); });
    expect(buildBrowserErrorContext({ boundary: "app", componentStack: "\n    at TaskDetail" })).toEqual({
      tags: { react_error_boundary: "app" },
      contexts: {
        react: { componentStack: "\n    at TaskDetail" },
        browser_state: { visibility_state: document.visibilityState },
        page_lifecycle: expect.objectContaining({ pagehide_seen: false }),
      },
    });
  });

  it("does not require a browser document", () => {
    vi.stubGlobal("document", undefined);
    expect(buildBrowserErrorContext({ boundary: "app" }).contexts.browser_state).toEqual({});
  });
});

/** A dispatched (untrusted) rejection event; jsdom has no PromiseRejectionEvent. */
function dispatchRejection(reason: unknown, promise?: unknown) {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  Object.defineProperty(event, "promise", { value: promise });
  window.dispatchEvent(event);
}

describe("page diagnostics", () => {
  startPageDiagnostics();

  function setNow(ms: number) {
    vi.spyOn(performance, "now").mockReturnValue(ms);
  }

  it("records only the latest lifecycle transition with coarse timing", () => {
    setNow(5_000);
    expect(readPageLifecycle()).toEqual({ since_load: "1-10s", pagehide_seen: false });

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setNow(65_000);
    expect(readPageLifecycle()).toEqual({
      since_load: "1-10m", pagehide_seen: false, last_transition: "hidden", since_transition: "1-10m",
    });

    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("resume"));
    setNow(65_500);
    expect(readPageLifecycle()).toMatchObject({ last_transition: "resume", since_transition: "<1s" });
  });

  it("keeps a pagehide marker until the page is shown again", () => {
    setNow(1_000_000);
    window.dispatchEvent(new Event("pagehide"));
    expect(readPageLifecycle()).toEqual({
      since_load: ">10m", pagehide_seen: true, last_transition: "pagehide", since_transition: "<1s",
    });
    window.dispatchEvent(new Event("pageshow"));
    expect(readPageLifecycle()).toMatchObject({ pagehide_seen: false, last_transition: "pageshow" });
  });

  it.each([
    ["native", Promise.resolve()],
    ["subclass", new (class Custom<T> extends Promise<T> {})(() => {})],
    ["other", { then() {} }],
    ["missing", undefined],
  ])("classifies a %s rejection promise without reading the reason", (kind, promise) => {
    setNow(100);
    const reason = { get secret() { throw new Error("must not be read"); } };
    dispatchRejection(reason, promise);
    expect(takeRejectionEventSnapshot("object")).toEqual({ trusted: false, promise: kind });
  });

  it("pairs a snapshot once, with the same rejection kind, inside the pairing window", () => {
    setNow(100);
    dispatchRejection(undefined, Promise.resolve());
    expect(takeRejectionEventSnapshot("undefined")).toEqual({ trusted: false, promise: "native" });
    expect(takeRejectionEventSnapshot("undefined")).toBeUndefined();

    dispatchRejection(undefined, Promise.resolve());
    expect(takeRejectionEventSnapshot("string")).toBeUndefined();

    dispatchRejection(undefined, Promise.resolve());
    setNow(5_101);
    expect(takeRejectionEventSnapshot("undefined")).toBeUndefined();
  });
});
