// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ToolMcpGatewayToken, ToolMcpGatewayWithTokens } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokensPanel } from "./TokensPanel";

const createGatewayTokenMock = vi.hoisted(() => vi.fn());
const revokeGatewayTokenMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    createGatewayToken: (...args: unknown[]) => createGatewayTokenMock(...args),
    revokeGatewayToken: (...args: unknown[]) => revokeGatewayTokenMock(...args),
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
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
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function token(overrides: Partial<ToolMcpGatewayToken> = {}): ToolMcpGatewayToken {
  return {
    id: "token-1",
    companyId: "company-1",
    gatewayId: "gateway-1",
    name: "cto-cursor",
    tokenPrefix: "pcgw_live_8x4Pa",
    subjectType: "gateway_client",
    subjectId: null,
    clientLabel: "Cursor",
    ownerNote: "Local IDE",
    allowedActions: ["tools/list", "tools/call"],
    expiresAt: "2026-09-01T00:00:00.000Z",
    expiryOverrideReason: null,
    expiryOverrideByUserId: null,
    expiryOverrideByAgentId: null,
    expiryOverrideAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function gateway(overrides: Partial<ToolMcpGatewayWithTokens> = {}): ToolMcpGatewayWithTokens {
  return {
    id: "gateway-1",
    companyId: "company-1",
    gatewayPublicId: "gw",
    name: "CTO agents",
    displaySlug: "cto-agents",
    slug: "cto-agents",
    description: null,
    status: "active",
    profileId: "profile-1",
    defaultProfileMode: "gateway_only",
    contextScopeType: "none",
    contextScopeId: null,
    agentId: null,
    projectId: null,
    issueId: null,
    approvalIssueId: null,
    endpointPath: "/g/cto-agents/mcp",
    authConfig: {} as ToolMcpGatewayWithTokens["authConfig"],
    headerPolicy: {} as ToolMcpGatewayWithTokens["headerPolicy"],
    metadataPolicy: {} as ToolMcpGatewayWithTokens["metadataPolicy"],
    onDemandToolsConfig: {} as ToolMcpGatewayWithTokens["onDemandToolsConfig"],
    metadata: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    tokens: [],
    clientSnippets: [],
    ...overrides,
  };
}

describe("TokensPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-06-16T12:00:00.000Z").getTime());
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(node: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
    await flushReact();
  }

  function clickButton(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (el) => el.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Button "${label}" not found`);
    return act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function setInput(selectorText: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(selectorText);
    if (!input) throw new Error(`Input ${selectorText} not found`);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    return act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("masks existing tokens and never renders the full secret at rest", async () => {
    await render(<TokensPanel companyId="company-1" gateway={gateway({ tokens: [token()] })} />);
    expect(container.textContent).toContain("pcgw_live_8x4Pa•••");
    expect(container.textContent).toContain("Active");
  });

  it("mints a token and reveals it once, then copies the full value", async () => {
    const created = { ...token({ id: "new-token" }), token: "pcgw_live_FULLSECRETVALUE" };
    createGatewayTokenMock.mockResolvedValue(created);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await render(<TokensPanel companyId="company-1" gateway={gateway()} />);

    await clickButton("Mint token"); // open the mint form
    await setInput('input[placeholder="cto-cursor"]', "cto-cursor");
    const form = container.querySelector("form");
    if (!form) throw new Error("mint form not found");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    expect(createGatewayTokenMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("New token — copy now");
    // Reveal-once banner shows the full value immediately after creation.
    expect(container.textContent).toContain("pcgw_live_FULLSECRETVALUE");

    await clickButton("Copy");
    expect(writeText).toHaveBeenCalledWith("pcgw_live_FULLSECRETVALUE");
  });

  it("gates revoke behind a typed confirmation matching the token name", async () => {
    revokeGatewayTokenMock.mockResolvedValue(token({ revokedAt: "2026-06-16T12:00:00.000Z" }));
    await render(<TokensPanel companyId="company-1" gateway={gateway({ tokens: [token()] })} />);

    await clickButton("Revoke");
    const confirmButton = [...container.querySelectorAll("button")].find(
      (el) => el.textContent?.trim() === "Revoke token",
    ) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    await setInput('input[aria-label="Type the token name to confirm"]', "cto-cursor");
    expect(confirmButton.disabled).toBe(false);

    await clickButton("Revoke token");
    await flushReact();
    expect(revokeGatewayTokenMock).toHaveBeenCalledWith("company-1", "token-1");
  });
});
