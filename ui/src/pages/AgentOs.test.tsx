// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentOs } from "./AgentOs";

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AgentOs page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders designed frontend previews for all Sprint 6-11 Agent OS surfaces", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<AgentOs />);
    });
    await flush();

    expect(container.textContent).toContain("Agent OS command center");
    expect(container.textContent).toContain("Preview-only");
    expect(container.textContent).toContain("no live MCP install/execution");
    expect(container.textContent).toContain("MCP marketplace");
    expect(container.textContent).toContain("blocked_pending_approval");
    expect(container.textContent).toContain("Organization packages");
    expect(container.textContent).toContain("Ready-agent pool");
    expect(container.textContent).toContain("CEO/PM");
    expect(container.textContent).toContain("Final delivery ops");
    expect(container.textContent).toContain("Telegram · chat …0123 · thread …0103");
    expect(container.textContent).not.toContain("demo-chat-0123");
    expect(container.textContent).toContain("Production-safe regression");
    expect(container.textContent).toContain("/api/health");
    expect(container.textContent).toContain("Learning loop");
    expect(container.textContent).toContain("pending_review");
    expect(container.textContent).toContain("approval-gated apply flows next");
    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith([{ label: "Agent OS" }]);

    await act(async () => root.unmount());
  });
});
