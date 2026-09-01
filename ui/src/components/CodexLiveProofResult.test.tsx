// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexLiveProofResult } from "./CodexLiveProofResult";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function recentLiveResult() {
  return {
    adapterType: "codex_local",
    status: "pass",
    testedAt: new Date().toISOString(),
    checks: [
      {
        code: "codex_hello_probe_passed",
        level: "info",
        message: "Raw probe message should stay hidden.",
        detail: "token=secret-value /Users/person/private user@example.com",
        hint: "Raw hint should stay hidden.",
      },
    ],
  };
}

describe("CodexLiveProofResult", () => {
  it("renders a neutral prompt before the first test", () => {
    const node = render(<CodexLiveProofResult result={null} />);
    expect(node.textContent).toContain("A fresh live reply is required");
    expect(node.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders a polite, canonical live reply without raw probe output", () => {
    const result = recentLiveResult();
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("localized date and time");
    const node = render(<CodexLiveProofResult result={result} />);
    const status = node.querySelector('[role="status"]');
    const timestamp = status?.querySelector("time");

    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("Live reply verified");
    expect(status?.textContent).toContain("Hello.");
    expect(timestamp?.getAttribute("dateTime")).toBe(result.testedAt);
    expect(timestamp?.textContent).toBe("localized date and time");
    expect(status?.textContent).not.toContain("secret-value");
    expect(status?.textContent).not.toContain("/Users/person/private");
    expect(status?.textContent).not.toContain("user@example.com");
    expect(status?.textContent).not.toContain("Raw probe message");
    expect(status?.textContent).not.toContain("Raw hint");
  });

  it("renders allowlisted warnings without raw warning fields", () => {
    const result = {
      ...recentLiveResult(),
      status: "warn",
      checks: [
        ...recentLiveResult().checks,
        {
          code: "codex_fast_mode_unsupported_model",
          level: "warn",
          message: "token=secret-value /Users/person/private",
          hint: "user@example.com",
        },
      ],
    };
    const node = render(<CodexLiveProofResult result={result} />);
    const warnings = node.querySelector('[aria-label="Codex connection warnings"]');

    expect(warnings?.textContent).toContain("Codex Fast mode is unavailable");
    expect(warnings?.textContent).not.toContain("secret-value");
    expect(warnings?.textContent).not.toContain("user@example.com");
  });

  it.each([
    ["failed", { ...recentLiveResult(), status: "fail" }],
    ["malformed", { detail: "token=secret-value /Users/person/private" }],
  ])("renders a safe alert for a %s result", (_name, result) => {
    const node = render(<CodexLiveProofResult result={result} />);
    const alert = node.querySelector('[role="alert"]');

    expect(alert?.textContent).toContain("Live reply not verified");
    expect(alert?.textContent).not.toContain("secret-value");
    expect(alert?.textContent).not.toContain("/Users/person/private");
  });
});
