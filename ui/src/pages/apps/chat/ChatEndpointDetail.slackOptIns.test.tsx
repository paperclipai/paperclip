// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackOptInScopeGroup } from "@paperclipai/shared";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatEndpointDetail } from "./ChatEndpointDetail";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), conversations: vi.fn(), activity: vi.fn(), setup: vi.fn(),
  resources: vi.fn(), updateResources: vi.fn(), navigate: vi.fn(),
  getConnection: vi.fn(), grants: vi.fn(), installs: vi.fn(), agentList: vi.fn(),
  slabTools: vi.fn(),
}));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: {
  get: mocks.get,
  update: mocks.update,
  listConversations: mocks.conversations,
  listActivityPage: mocks.activity,
  setup: mocks.setup,
  listResources: mocks.resources,
  updateResources: mocks.updateResources,
} }));
vi.mock("@/api/tools", () => ({ toolsApi: {
  getConnection: mocks.getConnection,
  listConnectionGrants: mocks.grants,
  getConnectionInstalls: mocks.installs,
} }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.agentList } }));
vi.mock("@/api/slackTools", () => ({ slackToolsApi: {
  capabilities: mocks.slabTools,
  listSearchAccess: vi.fn(async () => ({ linked: false })),
} }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }),
}));
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ state: null }),
  useParams: () => ({ endpointId: "endpoint-a", tab: "settings" }),
  useNavigate: () => mocks.navigate,
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) =>
    <a href={to} {...props}>{children}</a>,
  Navigate: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

const baseSetup = {
  step: "complete",
  slackSetupMethod: "managed" as const,
  slackApp: { appName: "maya-paperclip", botName: "maya", command: "/maya" },
};

function slackEndpoint(overrides: Partial<ChatEndpoint> = {}) {
  return {
    id: "endpoint-a", companyId: "company", connectionId: "runtime",
    provider: "slack", status: "active", assignedAgentId: "agent-a", assignedAgentName: "Maya",
    botExternalId: "B123", allowUnlinkedPeople: false, trustUnlinkedPeople: false,
    allowDirectMessages: true,
    setup: { ...baseSetup, slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
    resources: [],
    ...overrides,
  } as unknown as ChatEndpoint;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(slackEndpoint());
  mocks.update.mockImplementation(async (_id: string, input: Record<string, unknown>) => slackEndpoint({
    setup: {
      ...baseSetup,
      ...(input as { slackOptInScopeGroups?: SlackOptInScopeGroup[] }),
    },
  }));
  mocks.resources.mockResolvedValue([]);
  mocks.conversations.mockResolvedValue([]);
  mocks.activity.mockResolvedValue({ items: [], nextCursor: null });
  mocks.agentList.mockResolvedValue([{ id: "agent-a", name: "Maya", status: "idle" }]);
  mocks.getConnection.mockResolvedValue({ id: "runtime", config: {} });
  mocks.grants.mockResolvedValue({ grants: [], capabilities: {} });
  mocks.installs.mockResolvedValue({ installs: [] });
  mocks.slabTools.mockResolvedValue({ missingScopes: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });

async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <TooltipProvider><ChatEndpointDetail /></TooltipProvider>
    </QueryClientProvider>,
  ));
  await vi.waitFor(() => {
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/Loading (connection|access|conversations|activity)…/);
  }, { timeout: 4000 });
  await settle();
  // The controls live under the "Slack permissions" advanced section.
  const summary = [...container.querySelectorAll("summary")]
    .find((node) => node.textContent?.includes("Slack permissions"));
  if (summary) await act(async () => summary.click());
}

function optInCheckbox(label: string) {
  const row = [...container.querySelectorAll("label")]
    .find((item) => item.textContent === label)!;
  return container.querySelector<HTMLButtonElement>(`#${row.htmlFor}`)!;
}

function buttonWithText(text: string) {
  return [...container.querySelectorAll("button")]
    .find((node) => node.textContent?.trim() === text);
}

describe("Slack permission opt-ins on the connection settings page", () => {
  it.each(["managed", "automatic"] as const)("keeps the %s configuration action after a pushed manifest is reverted to the live grant", async slackSetupMethod => {
    const pushed = slackEndpoint({ setup: { ...baseSetup, slackSetupMethod,
      slackOptInScopeGroups: ["channel_management", "file_upload"], slackInstalledOptInScopeGroups: ["channel_management"],
      slackRegistration: { status: "install", appId: "A123" },
    } });
    mocks.get.mockResolvedValue(pushed);
    mocks.update.mockResolvedValue(slackEndpoint({ setup: { ...baseSetup, slackSetupMethod,
      slackOptInScopeGroups: ["channel_management"], slackInstalledOptInScopeGroups: ["channel_management"],
      slackRegistration: { status: "install", appId: "A123", errorCode: "slack_permissions_update_pending" },
    } }));
    await render();
    await act(async () => optInCheckbox("File upload").click());
    await vi.waitFor(() => expect(optInCheckbox("File upload").getAttribute("aria-checked")).toBe("false"));
    expect(buttonWithText(slackSetupMethod === "managed" ? "Reinstall in Slack" : "Update app and reinstall")).toBeDefined();
    expect(container.textContent).toContain("configuration still needs");
    expect(container.querySelectorAll('[data-slack-opt-in-status="enabled"]')).toHaveLength(1);
    expect(optInCheckbox("Channel management").getAttribute("aria-checked")).toBe("true");
    expect(container.querySelectorAll('[data-slack-opt-in-status="off"]')).toHaveLength(1);
  });

  it("does not replace new permission choices with an older general-settings response", async () => {
    let resolveGeneral!: (endpoint: ChatEndpoint) => void;
    const older = slackEndpoint({ allowDirectMessages: false });
    mocks.update.mockImplementation(async (_id: string, input: { slackOptInScopeGroups?: SlackOptInScopeGroup[] }) => {
      if (!input.slackOptInScopeGroups) return new Promise<ChatEndpoint>(resolve => { resolveGeneral = resolve; });
      return slackEndpoint({ setup: { ...baseSetup, slackOptInScopeGroups: input.slackOptInScopeGroups, slackInstalledOptInScopeGroups: [] } });
    });
    await render();
    const dmLabel = [...container.querySelectorAll("p")].find(node => node.textContent === "Allow direct messages")!;
    const dmToggle = dmLabel.closest(".flex")!.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    await act(async () => dmToggle.click());
    await vi.waitFor(() => expect(resolveGeneral).toBeDefined());
    await act(async () => optInCheckbox("File upload").click());
    await vi.waitFor(() => expect(optInCheckbox("File upload").getAttribute("aria-checked")).toBe("true"));
    await act(async () => resolveGeneral(older));
    await settle();
    await act(async () => optInCheckbox("Channel management").click());
    await vi.waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith("endpoint-a", {
      slackOptInScopeGroups: ["channel_management", "file_upload"],
    }));
  });
  it("renders both groups off for an agent with no opt-ins", async () => {
    await render();
    expect(container.textContent).toContain("Extra Slack permissions");
    for (const label of ["Channel management", "File upload"]) {
      expect(optInCheckbox(label).getAttribute("aria-checked")).toBe("false");
    }
  });

  it("saves only the opt-in field when a group is enabled", async () => {
    await render();
    await act(async () => optInCheckbox("File upload").click());
    await vi.waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("endpoint-a", { slackOptInScopeGroups: ["file_upload"] }));
  });

  it("offers a managed reinstall once the request differs from the install", async () => {
    mocks.get.mockResolvedValue(slackEndpoint({
      setup: { ...baseSetup, slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: [] },
    }));
    await render();
    const notice = container.querySelector('[role="status"]')!;
    expect(notice.textContent).toContain("differs from what Slack granted");
    const reinstall = buttonWithText("Reinstall in Slack")!;
    expect(reinstall).toBeDefined();
    await act(async () => reinstall.click());
    expect(mocks.navigate).toHaveBeenCalledWith(
      "/apps/chat/connect?provider=slack&purpose=chat&resume=endpoint-a&reconnect=1");
  });

  it("offers the own-app update-then-reinstall wording", async () => {
    mocks.get.mockResolvedValue(slackEndpoint({
      setup: {
        ...baseSetup,
        slackSetupMethod: "automatic",
        slackOptInScopeGroups: ["file_upload"],
        slackInstalledOptInScopeGroups: [],
      },
    }));
    await render();
    expect(buttonWithText("Update app and reinstall")).toBeDefined();
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain("Update the app configuration");
  });

  it("shows a legacy install as enabled with no pending prompt", async () => {
    // Neither opt-in field present: a pre-TECH-7988 installation.
    mocks.get.mockResolvedValue(slackEndpoint({ setup: { ...baseSetup } }));
    await render();
    const boxes = [...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')];
    // Guard against a vacuous pass: the section must actually be rendered.
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => box.getAttribute("aria-checked") === "true")).toBe(true);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(buttonWithText("Reinstall in Slack")).toBeUndefined();
  });
});
