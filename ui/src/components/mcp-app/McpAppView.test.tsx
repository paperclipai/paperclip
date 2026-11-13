// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpAppViewDetail } from "@paperclipai/shared";
import { McpAppViewContent } from "./McpAppView";
import { mcpAppNavigationGuardSupported } from "./mcp-app-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const detail: McpAppViewDetail = {
  id: "view-1", issueId: "issue-1", runId: "run-1", connectionId: "conn-1", applicationName: "Circleback",
  toolName: "mcp.circleback:displaymeetings", upstreamToolName: "DisplayMeetings", resourceUri: "ui://circleback/meetings",
  toolInput: {}, createdAt: "2026-11-12T00:00:00.000Z",
  toolResult: { content: [] },
  resource: { uri: "ui://circleback/meetings", html: "<p>cards</p>", csp: {}, permissions: {}, prefersBorder: true },
};

async function render() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(
    <McpAppViewContent detail={detail} status="ready" callTool={async () => ({ content: [] })} displayName="Display meetings" />,
  ));
  return { container, root };
}

afterEach(() => vi.unstubAllGlobals());

describe("McpAppViewContent", () => {
  it("does not mount a view where the navigation guard cannot work", async () => {
    expect(mcpAppNavigationGuardSupported()).toBe(false);
    const { container, root } = await render();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("This browser can't show this app's widget safely.");
    await act(async () => root.unmount());
  });

  it("mounts the view where the Navigation API is available", async () => {
    vi.stubGlobal("navigation", { addEventListener: () => undefined });
    const { container, root } = await render();
    expect(container.querySelector("iframe")).not.toBeNull();
    await act(async () => root.unmount());
  });
});
