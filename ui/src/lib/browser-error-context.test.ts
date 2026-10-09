// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBrowserErrorContext, sanitizeComponentStack } from "./browser-error-context";

afterEach(() => {
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
      },
    });
  });

  it("does not require a browser document", () => {
    vi.stubGlobal("document", undefined);
    expect(buildBrowserErrorContext({ boundary: "app" }).contexts.browser_state).toEqual({});
  });
});
