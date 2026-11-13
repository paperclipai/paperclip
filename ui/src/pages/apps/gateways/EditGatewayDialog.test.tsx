// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolMcpGatewayWithTokens, ToolProfileWithDetails } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditGatewayDialog } from "./EditGatewayDialog";

const updateGatewayMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: { updateGateway: (...args: unknown[]) => updateGatewayMock(...args) },
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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function gateway(): ToolMcpGatewayWithTokens {
  return {
    id: "gateway-1",
    companyId: "company-1",
    gatewayPublicId: "public-1",
    name: "Runtime Notion",
    displaySlug: "runtime-notion",
    slug: "runtime-notion",
    description: "Original description",
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
    tokens: [],
    clientSnippets: [],
  };
}

function profile(id: string, name: string): ToolProfileWithDetails {
  return {
    id,
    companyId: "company-1",
    profileKey: id,
    name,
    description: null,
    status: "active",
    defaultAction: "deny",
    newToolsReviewedAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    entries: [],
    bindings: [],
    summary: {
      accessMode: "selected",
      allowedToolCount: 2,
      allowedApplicationCount: 1,
      excludedToolCount: 0,
      totalToolCount: 2,
      assignmentCount: 1,
      appliesToAgentCount: 1,
      isCompanyDefault: false,
    },
  } as ToolProfileWithDetails;
}

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("EditGatewayDialog", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("updates an editable gateway name, description, and access profile", async () => {
    const existing = gateway();
    updateGatewayMock.mockResolvedValue({ ...existing, name: "Shared Notion", profileId: "profile-2" });
    const onOpenChange = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <EditGatewayDialog
            companyId="company-1"
            gateway={existing}
            profiles={[profile("profile-1", "Original"), profile("profile-2", "Shared tools")]}
            open
            onOpenChange={onOpenChange}
          />
        </QueryClientProvider>,
      );
    });

    const nameInput = container.querySelector<HTMLInputElement>('input[required]');
    const descriptionInput = container.querySelector<HTMLTextAreaElement>("textarea");
    const profileSelect = container.querySelector<HTMLSelectElement>("select");
    const form = container.querySelector("form");
    if (!nameInput || !descriptionInput || !profileSelect || !form) throw new Error("gateway edit form missing");

    const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    flushSync(() => {
      inputSetter?.call(nameInput, "Shared Notion");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => {
      textareaSetter?.call(descriptionInput, "For the research team");
      descriptionInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => {
      profileSelect.value = "profile-2";
      profileSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushReact();

    expect(updateGatewayMock).toHaveBeenCalledWith("company-1", "gateway-1", {
      name: "Shared Notion",
      description: "For the research team",
      profileId: "profile-2",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
