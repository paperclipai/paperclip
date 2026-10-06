// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ToolMcpGatewayToken,
  ToolMcpGatewayTokenCreated,
  ToolMcpGatewayWithTokens,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectClientDialog } from "./ConnectClientDialog";
import { i18n } from "@/i18n";
import { toolsApi } from "@/api/tools";

const copyTextMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: { createGatewayToken: vi.fn() },
}));

vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: (value: string) => copyTextMock(value),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/SearchableSelect", () => ({
  SearchableSelect: ({ value, groups, onValueChange }: {
    value: string;
    groups: Array<{ options: Array<{ key: string; value: string; label: string }> }>;
    onValueChange: (value: string, option: { key: string; value: string; label: string }) => void;
  }) => {
    const options = groups.flatMap((group) => group.options);
    return (
      <select
        aria-label="Available token"
        value={value}
        onChange={(event) => {
          const option = options.find((candidate) => candidate.value === event.target.value);
          if (option) onValueChange(option.value, option);
        }}
      >
        {options.map((option) => <option key={option.key} value={option.value}>{option.label}</option>)}
      </select>
    );
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function storedToken(): ToolMcpGatewayToken {
  return {
    id: "token-1",
    companyId: "company-1",
    gatewayId: "gateway-1",
    name: "research-client",
    tokenPrefix: "pcgw_abcd1234",
    subjectType: "gateway_client",
    subjectId: null,
    clientLabel: "research-client",
    ownerNote: "",
    allowedActions: ["tools/list", "tools/call"],
    expiresAt: "2026-12-01T00:00:00.000Z",
    expiryOverrideReason: null,
    expiryOverrideByUserId: null,
    expiryOverrideByAgentId: null,
    expiryOverrideAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function gateway(token: ToolMcpGatewayToken): ToolMcpGatewayWithTokens {
  return {
    id: "gateway-1",
    companyId: "company-1",
    gatewayPublicId: "public-1",
    name: "Research gateway",
    displaySlug: "research",
    slug: "research",
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
    endpointPath: "/api/tool-gateway/gateways/public-1/mcp",
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
    tokens: [token],
    clientSnippets: [{
      client: "vscode",
      label: "VS Code",
      config: {
        servers: {
          Paperclip: {
            url: "/api/tool-gateway/gateways/public-1/mcp",
            headers: { Authorization: "Bearer pcgw_..." },
          },
        },
      },
      notes: [],
    }],
  };
}

describe("ConnectClientDialog", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    copyTextMock.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    flushSync(() => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
  });

  it("copies a complete client snippet with the selected token and explains the gateway boundary", async () => {
    const persisted = storedToken();
    const created = { ...persisted, token: "pcgw_FULL_SECRET" } satisfies ToolMcpGatewayTokenCreated;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ConnectClientDialog
            gateway={gateway(persisted)}
            open
            onOpenChange={vi.fn()}
            createdTokens={[created]}
            onTokenCreated={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(container.textContent).toContain("does not give it access to Paperclip or skills");
    const copyButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Copy");
    if (!copyButton) throw new Error("snippet copy button missing");
    copyButton.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(copyTextMock).toHaveBeenCalledWith(expect.stringContaining('"Authorization": "Bearer pcgw_FULL_SECRET"'));
    expect(copyTextMock).toHaveBeenCalledWith(expect.stringContaining(
      `${window.location.origin}/api/tool-gateway/gateways/public-1/mcp`,
    ));
    expect(container.textContent).not.toContain("pcgw_FULL_SECRET");
  });

  it("translates the Authorization heading while preserving selected token IDs and copied HTTP syntax", async () => {
    const persisted = storedToken();
    const second = { ...persisted, id: "raw-token-2", name: "Raw second client", tokenPrefix: "pcgw_second" };
    const model = { ...gateway(persisted), tokens: [persisted, second] };
    const createdTokens = [
      { ...persisted, token: "pcgw_FAKE_FIRST_TEST_TOKEN" },
      { ...second, token: "pcgw_FAKE_SECOND_TEST_TOKEN" },
    ];
    const original = JSON.stringify({ model, createdTokens });
    const onOpenChange = vi.fn();
    const onTokenCreated = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ConnectClientDialog gateway={model} open onOpenChange={onOpenChange} createdTokens={createdTokens} onTokenCreated={onTokenCreated} />
    </QueryClientProvider>));
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "raw-token-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const heading = [...container.querySelectorAll("span")].find((span) => span.textContent === "Authorization")!;
    expect(heading).toBeDefined();
    for (const [locale, title] of [["en", "Authorization"], ["ru", "Авторизация"], ["en", "Authorization"]] as const) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(heading.isConnected).toBe(true);
      expect(heading.textContent).toBe(title);
      expect(container.querySelector("select")).toBe(select);
      expect(select.value).toBe("raw-token-2");
      expect(select.selectedOptions[0].textContent).toBe("Raw second client");
      expect(container.textContent).toContain('"Authorization": "Bearer ');
      expect(container.textContent).not.toContain("pcgw_FAKE_SECOND_TEST_TOKEN");
      expect(JSON.stringify({ model, createdTokens })).toBe(original);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onTokenCreated).not.toHaveBeenCalled();
      expect(toolsApi.createGatewayToken).not.toHaveBeenCalled();
      expect(copyTextMock).not.toHaveBeenCalled();
    }
    const copyHeader = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Copy header")!;
    await act(async () => copyHeader.click());
    expect(copyTextMock).toHaveBeenCalledExactlyOnceWith("Authorization: Bearer pcgw_FAKE_SECOND_TEST_TOKEN");
    client.clear();
  });
});
