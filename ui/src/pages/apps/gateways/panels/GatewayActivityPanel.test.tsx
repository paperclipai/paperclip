// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolMcpGatewayWithTokens } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayActivityPanel } from "./GatewayActivityPanel";

const listActivityMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listActivity: (...args: unknown[]) => listActivityMock(...args),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function event(id = "event-1", toolDisplayName = "Send Email") {
  return {
    id,
    companyId: "company-1",
    action: "tool_gateway.call_completed",
    actorType: "gateway_client",
    actorId: "client-1",
    entityType: "tool_mcp_gateway",
    entityId: "gateway-1",
    details: { reasonCode: "tool_completed" },
    createdAt: "2026-08-20T12:00:00.000Z",
    agentId: null,
    runId: null,
    applicationId: "app-1",
    connectionId: "connection-1",
    agentDisplayName: null,
    appDisplayName: "Gmail",
    applicationDisplayName: "Gmail",
    connectionDisplayName: "Gmail",
    toolDisplayName,
    normalizedOutcome: "allowed",
    invocation: {
      id: `invocation-${id}`,
      toolName: "gmail:send_email",
      status: "succeeded",
      policyDecision: "allow",
      approvalState: "not_required",
      argumentsSummary: { summary: JSON.stringify({ to: "person@example.test", token: "***REDACTED***" }) },
      resultSummary: { summary: JSON.stringify({ delivered: true }) },
      resultSizeBytes: 18,
      errorCode: null,
      errorMessage: null,
      startedAt: "2026-08-20T12:00:00.000Z",
      completedAt: "2026-08-20T12:00:00.125Z",
    },
  };
}

describe("GatewayActivityPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listActivityMock.mockResolvedValue({ events: [event()], nextCursor: null });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <GatewayActivityPanel
            companyId="company-1"
            gateway={{ id: "gateway-1" } as ToolMcpGatewayWithTokens}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  function clickButton(text: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
    expect(button, `button containing ${text}`).toBeTruthy();
    return act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("filters by gateway and expands redacted call details", async () => {
    await render();

    expect(listActivityMock).toHaveBeenCalledWith("company-1", {
      gateway: "gateway-1",
      window: "30d",
      limit: 25,
      cursor: undefined,
    });
    expect(container.textContent).toContain("Client used Send Email in Gmail");

    await clickButton("used Send Email");
    expect(container.textContent).toContain("gmail:send_email");
    expect(container.textContent).toContain("Arguments (redacted)");
    expect(container.textContent).toContain("***REDACTED***");
    expect(container.textContent).toContain("Result (redacted)");
    expect(container.textContent).toContain("125 ms");
  });

  it("loads the next cursor page", async () => {
    listActivityMock.mockImplementation((_companyId: string, params: { cursor?: string }) =>
      params.cursor === "cursor-2"
        ? Promise.resolve({ events: [event("event-2", "Read Email")], nextCursor: null })
        : Promise.resolve({ events: [event()], nextCursor: "cursor-2" }),
    );
    await render();

    await clickButton("Load more");
    await flushReact();
    expect(container.textContent).toContain("Read Email");
  });
});
