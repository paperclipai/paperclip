// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatEndpointDetail } from "./ChatEndpointDetail";
import { queryKeys } from "@/lib/queryKeys";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), listResources: vi.fn(), refreshDiscordChannels: vi.fn(), removeDiscordChannel: vi.fn(), setup: vi.fn(),
  conversations: vi.fn(), activity: vi.fn(), agents: vi.fn(), pushToast: vi.fn(),
}));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: {
  get: mocks.get, listResources: mocks.listResources, refreshDiscordChannels: mocks.refreshDiscordChannels, removeDiscordChannel: mocks.removeDiscordChannel,
  setup: mocks.setup, update: vi.fn(), updateResources: vi.fn(), listConversations: mocks.conversations, listActivityPage: mocks.activity,
} }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.agents } }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: mocks.pushToast }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ state: null }),
  useParams: () => ({ endpointId: "discord-bot", tab: "settings" }), useNavigate: () => vi.fn(),
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
  Navigate: () => null,
}));

const lab = { id: "lab", type: "channel", label: "#agent-lab", availability: "available", enabled: true };
const releases = { id: "releases", type: "channel", label: "#releases", availability: "available", enabled: false };

describe("Discord channel refresh", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const endpoint = { id: "discord-bot", companyId: "company", connectionId: "runtime", provider: "discord",
    assignedAgentId: "maya", assignedAgentName: "Maya", status: "active", setup: {} };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(endpoint);
    mocks.listResources.mockResolvedValue([lab]);
    mocks.agents.mockResolvedValue([]);
    mocks.conversations.mockResolvedValue([]);
    mocks.activity.mockResolvedValue({ items: [], nextCursor: null });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function render() {
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><ChatEndpointDetail /></TooltipProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain("#agent-lab"), { timeout: 3000 });
  }
  const refreshButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Refresh channels"]');

  it("replaces the destination list with the refreshed Discord inventory", async () => {
    mocks.refreshDiscordChannels.mockResolvedValue([lab, releases]);
    await render();
    await act(async () => refreshButton()!.click());
    await vi.waitFor(() => expect(container.textContent).toContain("#releases"), { timeout: 3000 });
    expect(mocks.refreshDiscordChannels).toHaveBeenCalledWith("discord-bot");
    expect(client.getQueryData(queryKeys.chatEndpoints.resources("discord-bot"))).toEqual([lab, releases]);
    expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });

  it("reports a failed refresh and keeps the saved list", async () => {
    mocks.refreshDiscordChannels.mockRejectedValue(new Error("Discord is unavailable"));
    await render();
    await act(async () => refreshButton()!.click());
    await vi.waitFor(() => expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't refresh channels", tone: "error" })), { timeout: 3000 });
    expect(container.textContent).toContain("#agent-lab");
    expect(refreshButton()!.disabled).toBe(false);
  });

  it("lets a channel deleted in Discord be turned off but not back on", async () => {
    mocks.listResources.mockResolvedValue([
      { ...lab, availability: "unavailable", enabled: true },
      { ...releases, availability: "unavailable", enabled: false },
    ]);
    await render();
    const toggle = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="Enable ${label}"]`)!;
    expect(toggle("#agent-lab").disabled).toBe(false);
    expect(toggle("#releases").disabled).toBe(true);
  });

  it("removes a deleted, disabled channel only after the warning is confirmed", async () => {
    const gone = { ...releases, availability: "unavailable", enabled: false };
    mocks.listResources.mockResolvedValue([{ ...lab, availability: "unavailable" }, gone]);
    mocks.removeDiscordChannel.mockResolvedValue([{ ...lab, availability: "unavailable" }]);
    await render();
    const removeButton = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${label}"]`);
    expect(removeButton("#agent-lab")).toBeNull();
    await act(async () => removeButton("#releases")!.click());
    const confirm = await vi.waitFor(() => {
      const button = [...document.body.querySelectorAll("button")].find((node) => node.textContent === "Remove channel");
      expect(button).toBeDefined();
      return button!;
    });
    expect(document.body.textContent).toContain("lose their link to it");
    expect(mocks.removeDiscordChannel).not.toHaveBeenCalled();
    await act(async () => confirm.click());
    await vi.waitFor(() => expect(container.textContent).not.toContain("#releases"), { timeout: 3000 });
    expect(mocks.removeDiscordChannel).toHaveBeenCalledWith("discord-bot", "releases");
    expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Channel removed", tone: "success" }));
  });

  it("locks channel toggles and removal while a refresh is in flight", async () => {
    const gone = { ...releases, availability: "unavailable", enabled: false };
    mocks.listResources.mockResolvedValue([lab, gone]);
    let finishRefresh!: (resources: unknown[]) => void;
    mocks.refreshDiscordChannels.mockReturnValue(new Promise((resolve) => { finishRefresh = resolve; }));
    await render();
    const toggle = () => container.querySelector<HTMLButtonElement>('[aria-label="Enable #agent-lab"]')!;
    const removeButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove #releases"]')!;
    expect(toggle().disabled).toBe(false);
    expect(removeButton().disabled).toBe(false);
    await act(async () => refreshButton()!.click());
    await vi.waitFor(() => expect(refreshButton()!.disabled).toBe(true));
    expect(toggle().disabled).toBe(true);
    expect(removeButton().disabled).toBe(true);
    await act(async () => finishRefresh([lab, gone]));
    await vi.waitFor(() => expect(toggle().disabled).toBe(false));
  });

  it("hides refresh while the bot is paused", async () => {
    mocks.get.mockResolvedValue({ ...endpoint, status: "paused" });
    await render();
    expect(refreshButton()).toBeNull();
  });
});
