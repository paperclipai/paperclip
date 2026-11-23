// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatEndpointDetail } from "./ChatEndpointDetail";
import { queryKeys } from "@/lib/queryKeys";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  tab: "settings", get: vi.fn(), conversations: vi.fn(), activity: vi.fn(), setup: vi.fn(),
  control: vi.fn(), getConnection: vi.fn(), grants: vi.fn(), installs: vi.fn(), agents: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: {
  get: mocks.get, listConversations: mocks.conversations, listActivityPage: mocks.activity, setup: mocks.setup,
} }));
vi.mock("@/api/email", () => ({ emailApi: { control: mocks.control } }));
vi.mock("@/api/tools", () => ({ toolsApi: {
  getConnection: mocks.getConnection, listConnectionGrants: mocks.grants, getConnectionInstalls: mocks.installs,
} }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.agents } }));
vi.mock("./EmailEndpointSetup", () => ({ EmailEndpointSettings: () => <h1>Email settings</h1> }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: () => {} }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ state: null }),
  useParams: () => ({ endpointId: "inbox", tab: mocks.tab }), useNavigate: () => mocks.navigate,
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
  Navigate: () => null,
}));

describe("AgentMail connection management tabs", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const endpoint = { id: "inbox", companyId: "company", connectionId: "runtime", provider: "agentmail",
    assignedAgentId: "ralph", assignedAgentName: "Ralph", botExternalId: "ralph@example.test",
    allowUnlinkedPeople: false, status: "active", setup: { step: "complete" } };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tab = "settings";
    mocks.get.mockResolvedValue(endpoint);
    mocks.getConnection.mockResolvedValue({ id: "runtime", companyId: "company", config: { credentialConnectionId: "account" } });
    mocks.grants.mockResolvedValue({ grants: [{ status: "active", kind: "organization" }], capabilities: { canConfigure: true } });
    mocks.installs.mockResolvedValue({ installs: [{ targetType: "agent", targetId: "ralph" }] });
    mocks.agents.mockResolvedValue([{ id: "ralph", name: "Ralph", status: "idle" }]);
    mocks.conversations.mockResolvedValue([]);
    mocks.activity.mockResolvedValue({ items: [], nextCursor: null });
    mocks.control.mockResolvedValue({ id: "inbox", companyId: "company", status: "paused" });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  async function render(tab: string) {
    mocks.tab = tab;
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><ChatEndpointDetail /></TooltipProvider></QueryClientProvider>));
    await vi.waitFor(() => {
      expect(container.textContent?.trim().length).toBeGreaterThan(0);
      expect(container.textContent).not.toMatch(/Loading (connection|access|conversations|activity)…/);
    }, { timeout: 3000 });
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
    expect(button).toBeDefined(); await act(async () => button!.click());
    await vi.waitFor(() => expect(button!.disabled).toBe(false), { timeout: 3000 });
    await settle();
  }
  it("renders settings only on Settings and loads the saved credential on Access", async () => {
    await render("settings"); expect(container.textContent).toContain("Email settings");
    await render("access");
    expect(container.textContent).not.toContain("Email settings");
    expect(container.textContent).toContain("Any human in the organization");
    expect(container.textContent).toContain("Ralph");
    expect(mocks.grants).toHaveBeenCalledWith("account"); expect(mocks.installs).toHaveBeenCalledWith("account");
    expect(mocks.grants).not.toHaveBeenCalledWith("runtime");
  });
  it("shows an access failure rather than editable controls when the credential cannot load", async () => {
    mocks.getConnection.mockRejectedValue(new Error("Offline")); await render("access");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load connection access");
    expect(container.querySelector('[role="radiogroup"]')).toBeNull(); expect(mocks.grants).not.toHaveBeenCalled();
  });
  it("uses inbox-local access for a legacy inbox with no saved account", async () => {
    mocks.getConnection.mockResolvedValue({ id: "runtime", config: {} }); await render("access");
    expect(mocks.grants).toHaveBeenCalledWith("runtime");
  });
  it("loads email conversations and links their tasks", async () => {
    mocks.conversations.mockResolvedValue([{ id: "thread", externalLabel: "Customer question", issueId: "task", issueTitle: "Help customer", state: "active" }]);
    await render("conversations"); expect(container.textContent).toContain("Customer question");
    expect(container.querySelector('a[href="/issues/task"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Email settings"); expect(mocks.conversations).toHaveBeenCalledWith("inbox");
  });
  it("gives an email-specific empty state and reports conversation load errors", async () => {
    await render("conversations"); expect(container.textContent).toContain("Send an email");
    client.removeQueries({ queryKey: queryKeys.chatEndpoints.conversations("inbox") });
    mocks.conversations.mockRejectedValue(new Error("Offline")); await render("conversations");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load the conversations");
    expect(container.textContent).not.toContain("No email conversations yet");
    mocks.conversations.mockResolvedValue([]); await click("Retry"); expect(container.textContent).toContain("Send an email");
  });
  it("loads activity and routes pause through the email API without replacing cached chat detail with an email summary", async () => {
    mocks.activity.mockImplementation(async () => {
      // Query completion can follow the initial endpoint render, especially
      // while the complete UI suite is running. Wait for data, not a short sleep.
      await new Promise(resolve => setTimeout(resolve, 100));
      return { items: [{ id: "delivery", kind: "delivery", status: "failed", summary: "Email received", createdAt: "2026-10-01T00:00:00Z", replayable: true,
      resolutionActions: ["retry_anyway"] }, { id: "publication", kind: "publication", status: "delivery_unknown", summary: "Email send unconfirmed",
      createdAt: "2026-10-01T00:00:00Z", resolutionActions: ["mark_delivered", "retry_anyway", "cancel"] }], nextCursor: null };
    });
    await render("activity"); expect(container.textContent).toContain("Email received");
    expect(container.textContent).not.toContain("Email settings"); expect(container.textContent).not.toContain("Replay");
    expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Resolve")).toBe(false);
    expect(container.querySelector('a[href="/apps/chat/inbox/conversations"]')).not.toBeNull();
    await click("Pause"); expect(mocks.control).toHaveBeenCalledWith("inbox", "pause"); expect(mocks.setup).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.chatEndpoints.detail("inbox"))).toMatchObject({ provider: "agentmail", assignedAgentName: "Ralph" });
    await click("Reconnect"); expect(mocks.navigate).toHaveBeenCalledWith("/apps/chat/inbox/settings");
  });
});
