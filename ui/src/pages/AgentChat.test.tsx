// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { AgentChat } from "./AgentChat";

const api = vi.hoisted(() => ({ list: vi.fn(), session: vi.fn(), get: vi.fn(), ensure: vi.fn(), visit: vi.fn(), enabled: true }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: api.list } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: api.session } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { get: api.get, ensure: api.ensure } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-raw" }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: api.enabled, loaded: true }) }));
vi.mock("@/lib/recent-agent-chats", () => ({ recordAgentChatVisit: api.visit }));
vi.mock("@/lib/router", () => ({ useParams: () => ({ agentRef: "agent-raw" }) }));
vi.mock("./IssueDetail", () => ({
  TaskDetailSurface: ({ conversation }: { conversation: { agent: { name: string }; ensureIssue: () => Promise<Issue> } }) =>
    <div><span>{conversation.agent.name}</span><textarea defaultValue="raw unsent draft" /><button onClick={() => { void conversation.ensureIssue(); }}>Ensure conversation</button></div>,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
afterEach(async () => {
  await act(async () => { root?.unmount(); await i18n.changeLanguage("en"); });
  container?.remove(); client?.clear(); vi.clearAllMocks(); api.enabled = true;
});
async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
async function renderPage() {
  api.list.mockResolvedValue([{ id: "agent-raw", companyId: "company-raw", name: "Board" }]);
  api.session.mockResolvedValue({ user: { id: "user-raw" } });
  api.get.mockResolvedValue(null);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => {
    await i18n.changeLanguage("en");
    root.render(<QueryClientProvider client={client}><AgentChat /></QueryClientProvider>);
  });
  await flush(); await flush();
}

describe("AgentChat localization", () => {
  it("reuses an in-flight conversation creation and preserves the unsent draft across language changes", async () => {
    let resolveCreation!: (issue: Issue) => void;
    api.ensure.mockReturnValue(new Promise<Issue>(resolve => { resolveCreation = resolve; }));
    await renderPage();
    const input = container.querySelector("textarea")!;
    expect(input).not.toBeNull();
    input.value = "unsaved пользовательский текст";
    await act(async () => { container.querySelector("button")!.click(); });
    const initialVisits = api.visit.mock.calls.length;
    const initialReads = api.get.mock.calls.length;
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("unsaved пользовательский текст");
    expect(container.textContent).toContain("Board");
    await act(async () => { container.querySelector("button")!.click(); });
    expect(api.ensure).toHaveBeenCalledExactlyOnceWith("company-raw", "agent-raw");
    expect(api.visit).toHaveBeenCalledTimes(initialVisits);
    expect(api.get).toHaveBeenCalledTimes(initialReads);
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(input.value).toBe("unsaved пользовательский текст");
    await act(async () => { resolveCreation({ id: "conversation-raw", companyId: "company-raw" } as Issue); });
  });

  it("retranslates disabled-conversation guidance without creating a conversation", async () => {
    api.enabled = false;
    await renderPage();
    expect(container.textContent).toContain("Agent Chat is disabled.");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Чат с агентом отключён.");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("Existing history remains available through task links.");
    expect(api.ensure).not.toHaveBeenCalled();
    expect(api.visit).not.toHaveBeenCalled();
  });
});
