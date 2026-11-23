// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolActionRequestListItem, ToolCatalogEntry } from "@paperclipai/shared";
import { ActionsSection } from "./PermissionsPanel";
import { ReviewPanel } from "./ReviewPanel";

const listActionRequestsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: { listActionRequests: (...args: unknown[]) => listActionRequestsMock(...args) },
}));

vi.mock("@/api/issues", () => ({
  issuesApi: { listInteractions: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY_ID, selectedCompany: { id: COMPANY_ID, issuePrefix: "PAP" } }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY_ID = "8b395da5-5593-58fb-8d9d-e2726a827b53";
const CONNECTION_ID = "3f1c2a8e-7b4d-4e0a-9c55-1d2e3f4a5b6c";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SERVICE_TOOL = /\b[a-z]+__[a-z_]+\b/;

function googleEntry(id: string, toolName: string, riskLevel: string): ToolCatalogEntry {
  return { id, toolName, title: null, description: null, riskLevel, status: "active" } as unknown as ToolCatalogEntry;
}

function googleRequest(): ToolActionRequestListItem {
  return {
    request: {
      id: "6a0e1d7c-3b2f-4a19-8e55-0c4d2b1a9f80",
      companyId: COMPANY_ID,
      invocationId: "0e9b7c6d-5a4f-4321-8bcd-ef0123456789",
      issueId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      interactionId: null,
      approvalId: null,
      status: "pending",
      previewMarkdown: null,
      requestedByAgentId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
      createdAt: new Date(Date.now() - 5 * 60_000),
      updatedAt: new Date(Date.now() - 5 * 60_000),
    },
    toolName: "calendar__create_event",
    toolTitle: null,
    connectionId: CONNECTION_ID,
    connectionName: "Google Workspace",
    applicationName: "Google Workspace",
    riskLevel: "write",
    requestedByAgentId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  } as unknown as ToolActionRequestListItem;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle() {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  ));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("Google Workspace action labels", () => {
  it("shows readable action names and no raw IDs on the Review tab", async () => {
    listActionRequestsMock.mockResolvedValue({ actionRequests: [googleRequest()] });
    const view = mount(
      <ReviewPanel
        connectionId={CONNECTION_ID}
        quarantined={[googleEntry("c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f", "gmail__get_message", "read")]}
        onReviewQuarantined={vi.fn()}
      />,
    );
    await settle();

    const text = view.textContent ?? "";
    expect(text).toContain("Gmail: Get message");
    expect(text).toContain("Calendar: Create event");
    expect(text).not.toMatch(SERVICE_TOOL);
    expect(text).not.toMatch(UUID);
  });

  it("shows readable action names on the Permissions action list", () => {
    const view = mount(
      <ActionsSection
        connectionId={CONNECTION_ID}
        appName="Google Workspace"
        readOnly={[googleEntry("d5e6f7a8-b9c0-4d1e-8f2a-3b4c5d6e7f80", "calendar__list_events", "read")]}
        canChange={[googleEntry("e6f7a8b9-c0d1-4e2f-8a3b-4c5d6e7f8091", "gmail__create_draft", "write")]}
        quarantined={[]}
        enabledIds={new Set()}
        askFirstIds={new Set()}
        disabled={false}
        refreshPending={false}
        canConfigure
        onSetPermission={vi.fn()}
        onReviewQuarantined={vi.fn()}
        onRefreshActions={vi.fn()}
      />,
    );

    const text = view.textContent ?? "";
    expect(text).toContain("Calendar: List events");
    expect(text).toContain("Gmail: Create draft");
    expect(text).not.toMatch(SERVICE_TOOL);
    expect(text).not.toMatch(UUID);
  });
});
