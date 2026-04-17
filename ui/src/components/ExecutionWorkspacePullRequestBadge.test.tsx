// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionWorkspacePullRequestRecord } from "@paperclipai/shared";
import { ExecutionWorkspacePullRequestBadge } from "./ExecutionWorkspacePullRequestBadge";

let container: HTMLElement | null = null;

function render(node: React.ReactNode) {
  const root = createRoot(container!);
  act(() => {
    root.render(node);
  });
  return root;
}

function baseRecord(
  overrides: Partial<ExecutionWorkspacePullRequestRecord> = {},
): ExecutionWorkspacePullRequestRecord {
  return {
    status: "requested",
    mode: "fire_and_forget",
    requestedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
    url: null,
    number: null,
    sha: null,
    mergedAt: null,
    error: null,
    policy: { autoOpen: true },
    ...overrides,
  };
}

describe("ExecutionWorkspacePullRequestBadge", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container?.remove();
    container = null;
  });

  it("renders the requested status with mode tooltip", () => {
    render(<ExecutionWorkspacePullRequestBadge record={baseRecord()} />);
    const badge = container!.querySelector<HTMLElement>(
      "[data-testid='execution-workspace-pull-request-badge']",
    );
    expect(badge).not.toBeNull();
    expect(badge?.dataset.status).toBe("requested");
    expect(badge?.dataset.mode).toBe("fire_and_forget");
    expect(badge?.textContent).toContain("PR requested");
    expect(badge?.title).toContain("Mode: fire-and-forget");
  });

  it("renders the merged status with tooltip", () => {
    render(
      <ExecutionWorkspacePullRequestBadge
        record={baseRecord({ status: "merged", mode: "blocking", mergedAt: "2026-01-01T00:05:00.000Z" })}
      />,
    );
    const badge = container!.querySelector<HTMLElement>(
      "[data-testid='execution-workspace-pull-request-badge']",
    );
    expect(badge?.dataset.status).toBe("merged");
    expect(badge?.dataset.mode).toBe("blocking");
    expect(badge?.textContent).toContain("PR merged");
  });

  it("wraps the badge in an anchor when record.url is set", () => {
    render(
      <ExecutionWorkspacePullRequestBadge
        record={baseRecord({ status: "opened", url: "https://git.example.com/pr/1" })}
      />,
    );
    const anchor = container!.querySelector<HTMLAnchorElement>("a[href='https://git.example.com/pr/1']");
    expect(anchor).not.toBeNull();
    expect(anchor?.target).toBe("_blank");
    expect(anchor?.textContent).toContain("PR opened");
  });

  it("surfaces the error in the tooltip when failed", () => {
    render(
      <ExecutionWorkspacePullRequestBadge
        record={baseRecord({ status: "failed", error: "token expired" })}
      />,
    );
    const badge = container!.querySelector<HTMLElement>(
      "[data-testid='execution-workspace-pull-request-badge']",
    );
    expect(badge?.title).toContain("Error: token expired");
  });
});
