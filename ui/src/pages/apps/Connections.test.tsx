// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connections } from "./Connections";

const listGalleryMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listAppsAttentionMock = vi.hoisted(() => vi.fn());
const listProfilesMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const archiveConnectionMock = vi.hoisted(() => vi.fn());
const getCloudConnectorEnrollmentMock = vi.hoisted(() => vi.fn());
const startCloudConnectorEnrollmentMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    listAppsAttention: (companyId: string) => listAppsAttentionMock(companyId),
    listProfiles: (companyId: string) => listProfilesMock(companyId),
    archiveConnection: (connectionId: string, options?: { confirmComposioChildren?: boolean }) =>
      archiveConnectionMock(connectionId, options),
    getCloudConnectorEnrollment: () => getCloudConnectorEnrollmentMock(),
    startCloudConnectorEnrollment: (companyId: string, label?: string) => startCloudConnectorEnrollmentMock(companyId, label),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId),
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// React 19 does not export a usable `act` in this vitest/jsdom setup; use the
// flushSync-based helper the sibling apps tests use (PAP-12371 gotcha).
async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function application(overrides: Record<string, unknown>) {
  return {
    id: "app-x",
    companyId: "company-1",
    applicationKey: undefined,
    name: "GitHub",
    description: null,
    type: "mcp_http",
    status: "active",
    pluginId: null,
    ownerAgentId: null,
    ownerUserId: null,
    metadata: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown>) {
  return {
    id: "conn-x",
    companyId: "company-1",
    applicationId: "app-x",
    name: "GitHub",
    connectionKind: "managed",
    transport: "mcp_remote",
    status: "active",
    transportConfig: {},
    config: {},
    credentialSecretRefs: [],
    healthStatus: "healthy",
    healthCheckedAt: null,
    lastError: null,
    credentialPolicy: "shared",
    enabled: true,
    lastUsedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function profile(connectionId: string, includedEntryIds: string[]) {
  return {
    id: `profile-${connectionId}`,
    companyId: "company-1",
    profileKey: `app:${connectionId}`,
    name: connectionId,
    description: null,
    status: "active",
    defaultAction: "deny",
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    entries: includedEntryIds.map((catalogEntryId, index) => ({
      id: `entry-${connectionId}-${index}`,
      companyId: "company-1",
      profileId: `profile-${connectionId}`,
      selectorType: "catalog_entry",
      effect: "include",
      applicationId: null,
      connectionId,
      catalogEntryId,
      toolName: null,
      riskLevel: null,
      conditions: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })),
    bindings: [],
  };
}

describe("Connections table (M1b / PAP-13254 door 2)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    listGalleryMock.mockResolvedValue({ apps: [] });
    listAppsAttentionMock.mockResolvedValue({ apps: [] });
    listApplicationsMock.mockResolvedValue({ applications: [] });
    listConnectionsMock.mockResolvedValue({ connections: [] });
    listProfilesMock.mockResolvedValue({ profiles: [] });
    listUserDirectoryMock.mockResolvedValue({ users: [] });
    archiveConnectionMock.mockResolvedValue(connection({ id: "c-deleted", status: "archived" }));
    getCloudConnectorEnrollmentMock.mockResolvedValue({
      configured: true,
      status: "active",
      brokerBaseUrl: "https://my.paperclip.app",
      instanceId: "instance-test",
      environment: "development",
      origins: ["http://localhost:3100"],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderApps() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Connections />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders applications without connections as not connected with a Connect action", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-github", name: "GitHub" })],
    });

    await renderApps();

    const text = container.textContent ?? "";
    expect(text).toContain("All (1)");
    expect(text).toContain("GitHub");
    expect(text).toContain("Not connected");
    expect(text).toContain("Connect it so agents can use it.");
    expect(text).toContain("Connect");

    const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
      tr.textContent?.includes("GitHub"),
    );
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigate).toHaveBeenCalledWith("/apps/app/app-github/permissions");

    mockNavigate.mockClear();
    const connectButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Connect") && !button.textContent.includes("Connect an app"),
    );
    connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigate).toHaveBeenCalledWith("/apps/app/app-github/permissions");
  });

  it("renders every account with its owner, status, actions, and direct edit navigation", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [
        application({ id: "app-github", name: "GitHub" }),
        application({ id: "app-slack", name: "Slack" }),
        application({ id: "app-notion", name: "Notion" }),
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "c-connected",
          applicationId: "app-github",
          name: "GitHub",
          healthStatus: "healthy",
          createdByUserId: "user-1",
          credentialPolicy: "per_user",
        }),
        connection({
          id: "c-attention",
          applicationId: "app-slack",
          name: "Slack",
          healthStatus: "error",
          lastUsedAt: new Date("2026-06-09T00:00:00Z"),
        }),
        connection({ id: "c-attention-2", applicationId: "app-slack", name: "Slack Team", healthStatus: "healthy" }),
        connection({ id: "c-paused", applicationId: "app-notion", name: "Notion", enabled: false }),
      ],
    });
    listAppsAttentionMock.mockResolvedValue({
      apps: [
        {
          connection: connection({ id: "c-attention", applicationId: "app-slack", name: "Slack", healthStatus: "error" }),
          healthNeedsAttention: true,
          quarantinedCatalogEntryCount: 0,
          pendingActionRequestCount: 0,
          reasons: ["health"],
        },
        {
          connection: connection({ id: "c-attention-2", applicationId: "app-slack", name: "Slack Team", healthStatus: "healthy" }),
          healthNeedsAttention: false,
          quarantinedCatalogEntryCount: 1,
          pendingActionRequestCount: 0,
          reasons: ["quarantined_catalog_entries"],
        },
      ],
    });
    listProfilesMock.mockResolvedValue({
      profiles: [
        profile("c-connected", ["a", "b", "c"]),
        profile("c-attention", ["a"]),
        profile("c-attention-2", ["b", "c"]),
      ],
    });
    listUserDirectoryMock.mockResolvedValue({
      users: [{
        principalId: "user-1",
        status: "active",
        user: {
          id: "user-1",
          name: "Dotta",
          email: "dotta@example.com",
          image: "https://example.com/dotta.png",
        },
      }],
    });

    await renderApps();

    const text = container.textContent ?? "";
    // 1. Connected rows lose the repeated hint.
    expect(text).not.toContain("Connected and ready");
    // 2. Attention + Paused rows keep their explanatory hint.
    expect(text).toContain("The key stopped working");
    expect(text).toContain("Paused — agents can");
    // 3. Every account has its own filterable row and health signal.
    expect(text).toContain("All (4)");
    expect(text).toContain("Needs attention (1)");
    expect(text).toContain("1 connection needs attention");
    // 3. New header columns are present.
    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent?.trim());
    expect(headers).toEqual(["Connection", "Type", "Connected by", "Status", "Actions", "Last used", ""]);
    expect(text).toContain("Personal");
    expect(text).toContain("Company");
    // 4. Actions column reflects enabled catalog entries per account; missing profile => 0 on.
    expect(text).toContain("3 on");
    expect(text).toContain("0 on");
    // 5. Last used renders a relative timestamp when present, dash when absent.
    expect(text).toContain("—");
    // 6. Multi-account apps appear once per connection and edit the selected account directly.
    expect(Array.from(container.querySelectorAll("tbody tr")).filter((tr) => tr.textContent?.includes("Slack"))).toHaveLength(2);
    const slackRow = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
      tr.textContent?.includes("Slack"),
    );
    slackRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigate).toHaveBeenCalledWith("/apps/c-attention/permissions");
    // 7. Button labels are honest: broken health says Reconnect, healthy/paused say Edit.
    const rowButtonLabel = (name: string, exact = false) =>
      Array.from(container.querySelectorAll("tbody tr"))
        .find((tr) => exact ? tr.textContent?.includes(name) && !tr.textContent?.includes("Slack Team") : tr.textContent?.includes(name))
        ?.querySelector("td:last-child button")?.textContent;
    expect(rowButtonLabel("GitHub")).toBe("Permissions");
    expect(rowButtonLabel("Slack", true)).toBe("Reconnect");
    expect(rowButtonLabel("Notion")).toBe("Permissions");
    // 8. Generic connection names inherit the originating user's first name.
    expect(text).toContain("Dotta’s GitHub");
    expect(text).toContain("Slack for the company");
    expect(text).toContain("Slack Team for the company");
    expect(container.querySelector('[title="Dotta"] [data-slot="avatar"]')).toBeTruthy();
    // Custom account labels remain untouched.
    expect(text).toContain("Slack Team");
  });

  // F6 (PAP-13254 §4): the row highlight and the Status pill derive from ONE
  // health signal, so they can never disagree. A healthy connection stays
  // "Healthy" / "Edit" and is not amber-highlighted, even if the broader
  // attention endpoint would once have flagged it (quarantine/new-tools review
  // now live on the app detail + Review door, not the Connections highlight).
  it("keeps a healthy app un-highlighted and editable — pill and highlight agree (F6)", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-github", name: "GitHub" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [connection({ id: "c-healthy", applicationId: "app-github", healthStatus: "healthy" })],
    });
    listAppsAttentionMock.mockResolvedValue({
      apps: [
        {
          connection: connection({ id: "c-healthy", applicationId: "app-github", healthStatus: "healthy" }),
          healthNeedsAttention: false,
          quarantinedCatalogEntryCount: 2,
          pendingActionRequestCount: 0,
          reasons: ["quarantined_catalog_entries"],
        },
      ],
    });

    await renderApps();

    expect(container.textContent).toContain("Healthy");
    // No attention: the danger banner and attention filter chip are inert.
    expect(container.textContent).not.toContain("needs attention");
    expect(container.textContent).toContain("Needs attention (0)");
    const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
      tr.textContent?.includes("GitHub"),
    );
    expect(row?.className).not.toContain("amber");
    const button = row?.querySelector("td:last-child button");
    expect(button?.textContent).toBe("Permissions");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigate).toHaveBeenCalledWith("/apps/c-healthy/permissions");
  });

  it("deletes a connection only after trash-can confirmation", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-github", name: "GitHub" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [connection({ id: "c-github", applicationId: "app-github", name: "GitHub" })],
    });

    await renderApps();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete GitHub for the company connection"]',
    );
    expect(deleteButton).toBeTruthy();

    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(archiveConnectionMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Delete GitHub connection?");

    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete connection",
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveConnectionMock).toHaveBeenCalledWith("c-github", {
      confirmComposioChildren: false,
    });
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Connection deleted",
        body: "GitHub is no longer available to agents and its credentials are deleted. Connecting it again needs a new sign-in or key.",
        tone: "success",
      }),
    );
  });

  it("confirms that deleting a Composio parent removes its child services", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-composio", name: "Composio" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "composio-parent",
          applicationId: "app-composio",
          name: "Composio",
          config: { sourceTemplateKey: "composio" },
        }),
        connection({
          id: "composio-github",
          applicationId: "app-composio",
          name: "GitHub (via Composio)",
          config: { provider: "composio", parentConnectionId: "composio-parent", toolkitSlug: "github" },
        }),
      ],
    });

    await renderApps();
    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Composio for the company connection"]',
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("This also removes 1 connected service");
    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete connection",
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveConnectionMock).toHaveBeenCalledWith("composio-parent", {
      confirmComposioChildren: true,
    });
  });

  it("reports the remaining active connections after deleting one", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-github", name: "GitHub" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({ id: "c-github-primary", applicationId: "app-github", name: "GitHub" }),
        connection({ id: "c-github-secondary", applicationId: "app-github", name: "GitHub Team" }),
      ],
    });

    await renderApps();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete GitHub for the company connection"]',
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain(
      "Agents can still use GitHub through 1 other active connection.",
    );

    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete connection",
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveConnectionMock).toHaveBeenCalledWith("c-github-primary", {
      confirmComposioChildren: false,
    });
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Connection deleted",
        body: "GitHub still has 1 active connection available to agents.",
        tone: "success",
      }),
    );
  });

  it("does not count disabled connections as available after deletion", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ id: "app-github", name: "GitHub" })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({ id: "c-github-primary", applicationId: "app-github", name: "GitHub" }),
        connection({
          id: "c-github-disabled",
          applicationId: "app-github",
          name: "GitHub Disabled",
          status: "disabled",
          enabled: false,
        }),
      ],
    });

    await renderApps();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete GitHub for the company connection"]',
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain(
      "The saved credentials are deleted and agents lose access immediately.",
    );
    expect(document.body.textContent).toContain("needs a new sign-in or key");
    expect(document.body.textContent).not.toContain("Agents can still use GitHub");

    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete connection",
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "GitHub is no longer available to agents and its credentials are deleted. Connecting it again needs a new sign-in or key.",
      }),
    );
  });
});
