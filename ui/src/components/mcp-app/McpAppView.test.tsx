// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/api/mcpApps", () => ({ mcpAppsApi: { messageSent: vi.fn(async () => ({ commentId: "c1" })) } }));
import type { McpAppViewDetail } from "@paperclipai/shared";
import { McpAppViewContent, useMcpAppMessageProposal, type McpAppViewContentProps } from "./McpAppView";
import { McpAppFrame } from "./McpAppFrame";
import { McpAppIssueProvider } from "./McpAppIssueContext";
import { mcpAppNavigationGuardSupported } from "./mcp-app-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const detail: McpAppViewDetail = {
  id: "view-1", issueId: "issue-1", runId: "run-1", connectionId: "conn-1", applicationName: "Circleback",
  toolName: "mcp.circleback:displaymeetings", upstreamToolName: "DisplayMeetings", resourceUri: "ui://circleback/meetings",
  toolInput: {}, createdAt: "2026-11-12T00:00:00.000Z",
  toolResult: { content: [] },
  resource: { uri: "ui://circleback/meetings", html: "<p>cards</p>", csp: {}, permissions: {}, prefersBorder: true },
};

async function render(props: Partial<McpAppViewContentProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <McpAppViewContent detail={detail} status="ready" callTool={async () => ({ content: [] })} displayName="Display meetings" {...props} />,
  ));
  return { container, root };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found as HTMLButtonElement;
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

  it("shows a view's proposed message under the widget and sends it only on Send", async () => {
    vi.stubGlobal("navigation", { addEventListener: () => undefined });
    const onSendProposal = vi.fn();
    const onDismissProposal = vi.fn();
    const { container, root } = await render({
      proposal: { text: "Summarize the Heavybit meeting", status: "pending" }, onSendProposal, onDismissProposal,
    });
    const card = container.querySelector("[data-testid=mcp-app-message-proposal]")!;
    expect(card.textContent).toContain("Circleback wants to send:");
    expect(card.textContent).toContain("Summarize the Heavybit meeting");
    // The card comes after the widget.
    expect(container.querySelector("iframe")!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(onSendProposal).not.toHaveBeenCalled();
    await act(async () => button("Dismiss").click());
    expect(onDismissProposal).toHaveBeenCalledTimes(1);
    await act(async () => button("Send").click());
    expect(onSendProposal).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows the view full screen in a dialog, with one frame at a time", async () => {
    vi.stubGlobal("navigation", { addEventListener: () => undefined });
    const onDisplayModeChange = vi.fn();
    const { container, root } = await render({ displayMode: "fullscreen", onDisplayModeChange });
    const dialog = document.querySelector("[data-testid=mcp-app-fullscreen]")!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelectorAll("iframe")).toHaveLength(1);
    expect(dialog.querySelector("iframe")!.getAttribute("data-display-mode")).toBe("fullscreen");
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(container.querySelector("[data-testid=mcp-app-view-fullscreen-placeholder]")).not.toBeNull();
    await act(async () => button("Exit full screen").click());
    expect(onDisplayModeChange).toHaveBeenCalledWith("inline");
    await act(async () => root.unmount());
    container.remove();
  });

  it("starts a new frame when the host's capabilities change, so the view handshakes again", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const frame = (proposeMessage?: (text: string) => Promise<void>) => (
      <McpAppFrame title="Circleback" viewId="view-1" toolName="DisplayMeetings" resource={detail.resource}
        toolInput={{}} toolResult={{ content: [] }} callTool={async () => ({ content: [] })} proposeMessage={proposeMessage} />
    );
    await act(async () => root.render(frame()));
    const first = container.querySelector("iframe");
    await act(async () => root.render(frame(async () => undefined)));
    expect(container.querySelector("iframe")).not.toBe(first);
    await act(async () => root.unmount());
  });

  it("retries a failed Send with the same request id, so the comment is posted once", async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(undefined);
    let api: ReturnType<typeof useMcpAppMessageProposal> | null = null;
    function Harness() {
      api = useMcpAppMessageProposal("issue-1", "view-1");
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<McpAppIssueProvider issueId="issue-1" sendMessage={sendMessage}><Harness /></McpAppIssueProvider>));
    let settled = false;
    await act(async () => { void api!.proposeMessage!("Summarize m1").then(() => { settled = true; }); });
    await act(async () => { api!.onSend!(); });
    expect(api!.proposal).toMatchObject({ status: "error" });
    expect(settled).toBe(false);
    await act(async () => { api!.onSend!(); });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]![1]).toBe(sendMessage.mock.calls[1]![1]);
    expect(settled).toBe(true);
    expect(api!.proposal).toBeNull();
    await act(async () => root.unmount());
  });
});
