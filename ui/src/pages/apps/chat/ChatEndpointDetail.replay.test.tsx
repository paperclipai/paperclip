// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatEndpointDetail } from "./ChatEndpointDetail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isBlockedFromReplay, replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), listPrincipals: vi.fn(), createLinkIntent: vi.fn(), agents: vi.fn(), navigate: vi.fn(),
}));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: {
  get: mocks.get, listPrincipals: mocks.listPrincipals, createLinkIntent: mocks.createLinkIntent,
  listConversations: vi.fn().mockResolvedValue([]), listActivityPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  listResources: vi.fn().mockResolvedValue([]),
} }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.agents } }));
vi.mock("./SlackTestMessageButton", () => ({ SlackTestMessageButton: () => null }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: () => {} }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ state: null }),
  useParams: () => ({ endpointId: "slack-bot", tab: "access" }), useNavigate: () => mocks.navigate,
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
  Navigate: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ id: "slack-bot", companyId: "company", provider: "slack", assignedAgentId: "maya", assignedAgentName: "Maya",
    allowUnlinkedPeople: false, status: "active", providerAccountLabel: "Globex Workspace", setup: { step: "complete" } });
  mocks.agents.mockResolvedValue([{ id: "maya", name: "Maya", status: "idle" }]);
  mocks.listPrincipals.mockResolvedValue([
    { id: "l1", principalId: "p1", status: "linked", externalLabel: "jane.doe (Globex)", paperclipUserLabel: "Jane Doe" },
    { id: "l2", principalId: "p2", status: "pending", externalLabel: "sam@globex.com", paperclipUserLabel: null },
  ]);
  mocks.createLinkIntent.mockResolvedValue({ confirmationUrl: "/chat-link/confirm?token=ctok_live_9f2a" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

it("masks linked people and blocks the identity confirmation link in session replay", async () => {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><ChatEndpointDetail /></TooltipProvider></QueryClientProvider>));
  await vi.waitFor(() => expect(container.textContent).toContain("sam@globex.com"), { timeout: 3000 });
  expect(replayLeaks("Globex Workspace", container)).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("Jane Doe", container)).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("jane.doe (Globex)", container)).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("sam@globex.com", container)).toEqual({ rendered: true, recorded: false });
  const create = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Create confirmation link"));
  await act(async () => create!.click());
  await vi.waitFor(() => expect(container.textContent).toContain("ctok_live_9f2a"), { timeout: 3000 });
  expect(isBlockedFromReplay("ctok_live_9f2a", container)).toBe(true);
  expect(replayLeaks("Confirm sam@globex.com", container)).toEqual({ rendered: true, recorded: false });
});
