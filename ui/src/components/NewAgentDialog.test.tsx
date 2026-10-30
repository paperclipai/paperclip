// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewAgentDialog } from "./NewAgentDialog";
import { queryKeys } from "@/lib/queryKeys";
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getExperimental: async () => ({ enableNativeRunner: true }),
  },
}));
const agents = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), get: vi.fn(), list: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: agents }));
const invites = vi.hoisted(() => ({ createCompanyInvite: vi.fn(), getInviteOnboarding: vi.fn(), copy: vi.fn() }));
vi.mock("../api/access", () => ({ accessApi: invites }));
vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: invites.copy }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
const dotApi = vi.hoisted(() => ({ create: vi.fn(), connection: vi.fn(), pair: vi.fn(), retry: vi.fn() }));
vi.mock("@/api/dotInvitations", () => ({ dotInvitationsApi: dotApi }));
const state = vi.hoisted(() => ({
  adapters: [] as object[],
  navigate: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@/lib/router", () => ({ useNavigate: () => state.navigate, Link: ({ to, children }: any) => createElement("a", { href: to }, children) }));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ newAgentOpen: true, closeNewAgent: state.close }),
}));
vi.mock("@/api/adapters", () => ({
  adaptersApi: { list: async () => state.adapters },
}));
vi.mock("./onboarding/PillGuy", () => ({ PillGuy: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
beforeEach(async () => {
  vi.clearAllMocks();
  const rows = new Map();
  Object.values(agents).forEach(mock => mock.mockReset());
  agents.list.mockResolvedValue([]);
  agents.create.mockImplementation(async (_company, input) => {
    const record = { ...input, id: input.setupId, pauseReason: "setup" };
    rows.set(record.id, record);
    return record;
  });
  agents.get.mockImplementation(async id => rows.get(id));
  agents.update.mockImplementation(async (id, input) => {
    const record = { ...rows.get(id), ...input, id };
    rows.set(id, record);
    return record;
  });
  Object.values(dotApi).forEach(mock => mock.mockReset());
  invites.createCompanyInvite.mockResolvedValue({ token: "one-time-token", onboardingTextPath: "/api/invites/one-time-token/onboarding.txt" });
  invites.getInviteOnboarding.mockResolvedValue({ onboarding: { connectivity: {} } });
  invites.copy.mockResolvedValue(undefined);
  state.adapters = [
    { type: "codex_local", loaded: true },
    { type: "paperclip_runner", loaded: true },
    { type: "claude_local", loaded: true, disabled: true },
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <NewAgentDialog />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  container.remove();
});
async function name(value = "Ada & Co") {
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Choose adapter");
}
it("requires a name and an enabled adapter before navigating", async () => {
  await click("Choose adapter");
  expect(document.body.textContent).toContain("Agent name");
  await name();
  expect(document.querySelector('input[value="claude_local"]')).toBeNull();
  await click("Configure agent");
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () =>
    (
      document.querySelector('input[value="codex_local"]') as HTMLInputElement
    ).click(),
  );
  await click("Configure agent");
  expect(state.close).toHaveBeenCalledTimes(1);
  const query = new URL(state.navigate.mock.calls[0][0], "http://local")
    .searchParams;
  expect(query.get("name")).toBe("Ada & Co");
  expect(query.get("adapterType")).toBe("codex_local");
});
it("saves identity on name submission before an adapter is selected", async () => {
  expect(agents.create).not.toHaveBeenCalled();
  await name();
  expect(agents.create).toHaveBeenCalledTimes(1);
  const input = agents.create.mock.calls[0][1];
  expect(input).toMatchObject({ name: "Ada & Co", adapterType: "process", metadata: { setupAdapterPending: true }, runtimeConfig: { heartbeat: { enabled: false } } });
  expect(document.body.textContent).toContain("Choose an adapter");
  expect(document.querySelector('input[name="new-agent-adapter"]:checked')).toBeNull();
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLInputElement>('input[value="codex_local"]')!.click());
  await click("Configure agent");
  expect(agents.create).toHaveBeenCalledTimes(1);
  expect(agents.update).toHaveBeenCalledWith(input.setupId, expect.objectContaining({ adapterType: "codex_local", metadata: { setupAdapterPending: false } }), "company-1");
  const query = new URL(state.navigate.mock.calls[0][0], "http://local").searchParams;
  expect(query.get("setupAgentId")).toBe(input.setupId);
  expect(query.get("runner")).toBe("auto");
});
it("retries a failed name save with the same identity", async () => {
  agents.create.mockRejectedValueOnce(new Error("Creation unavailable"));
  await name();
  expect(document.body.textContent).toContain("Creation unavailable");
  expect(document.body.textContent).not.toContain("Choose an adapter");
  await click("Choose adapter");
  expect(agents.create).toHaveBeenCalledTimes(2);
  expect(agents.create.mock.calls[1][1].setupId).toBe(agents.create.mock.calls[0][1].setupId);
  expect(document.body.textContent).toContain("Choose an adapter");
});
it("keeps the draft on adapter save failure and updates it on retry", async () => {
  await name();
  await act(async () => document.querySelector<HTMLInputElement>('input[value="codex_local"]')!.click());
  agents.update.mockRejectedValueOnce(new Error("Save unavailable"));
  await click("Configure agent");
  expect(document.body.textContent).toContain("Save unavailable");
  expect(state.navigate).not.toHaveBeenCalled();
  await click("Configure agent");
  expect(agents.update.mock.calls[1][0]).toBe(agents.create.mock.calls[0][1].setupId);
  expect(state.navigate).toHaveBeenCalledTimes(1);
});
it("keeps the same record after returning to the name step", async () => {
  await name();
  await click("Back");
  await name();
  expect(agents.create).toHaveBeenCalledTimes(1);
});
it("ignores repeated name submission while the record is being saved", async () => {
  let finish!: (value: object) => void;
  agents.create.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await name();
  const input = agents.create.mock.calls[0][1];
  await act(async () => {
    const form = document.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(agents.create).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ...input, id: input.setupId }));
  expect(document.body.textContent).toContain("Choose an adapter");
});
it("does not navigate after closing while an adapter save is pending", async () => {
  await name();
  await act(async () => document.querySelector<HTMLInputElement>('input[value="codex_local"]')!.click());
  let finish!: (value: object) => void;
  agents.update.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await click("Configure agent");
  await act(async () => root.render(null));
  await act(async () => finish({ id: agents.create.mock.calls[0][1].setupId, name: "Ada & Co" }));
  expect(state.navigate).not.toHaveBeenCalled();
});
it("can save the name when the process adapter is disabled", async () => {
  await act(async () => cache.setQueryData(queryKeys.adapters.availability("company-1", null), [...state.adapters, { type: "process", loaded: true, disabled: true }]));
  await name();
  expect(agents.create.mock.calls[0][1]).toMatchObject({ adapterType: "codex_local", metadata: { setupAdapterPending: true } });
  expect(document.querySelector('input[name="new-agent-adapter"]:checked')).toBeNull();
});
it("keeps the server-assigned name when a duplicate is numbered", async () => {
  agents.create.mockImplementationOnce(async (_company, input) => ({ ...input, id: input.setupId, name: "Ada & Co 2" }));
  await name();
  expect(document.body.textContent).toContain("How should Ada & Co 2 work?");
  expect(agents.update).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLInputElement>('input[value="codex_local"]')!.click());
  await click("Configure agent");
  expect(agents.update.mock.calls[0][1].name).toBe("Ada & Co 2");
  const query = new URL(state.navigate.mock.calls[0][0], "http://local").searchParams;
  expect(query.get("name")).toBe("Ada & Co 2");
});
it("renames a numbered draft only after the user edits its name", async () => {
  agents.create.mockImplementationOnce(async (_company, input) => ({ ...input, id: input.setupId, name: "Ada & Co 2" }));
  await name();
  expect(agents.update).not.toHaveBeenCalled();
  await click("Back");
  await name("Grace");
  expect(agents.create).toHaveBeenCalledTimes(1);
  expect(agents.update).toHaveBeenCalledWith(agents.create.mock.calls[0][1].setupId, { name: "Grace" }, "company-1");
  expect(document.body.textContent).toContain("How should Grace work?");
});
it("offers one Codex harness without a runner/provider tile", async () => {
  await name();
  expect(document.querySelector('input[value="paperclip_runner"]')).toBeNull();
  expect(document.querySelectorAll('input[value="codex_local"]')).toHaveLength(1);
  expect(document.querySelector("select")).toBeNull();
});
it.each([true, false, undefined])("opens saved-token Copilot setup without an experimental override (%s)", async enableNativeRunner => {
  await act(async () => cache.setQueryData(queryKeys.instance.experimentalSettings, { enableNativeRunner }));
  await name();
  await act(async () => document.querySelector<HTMLInputElement>('input[value="copilot_runtime"]')!.click());
  await click("Configure agent");
  const query = new URL(state.navigate.mock.calls[0][0], "http://local").searchParams;
  expect(query.get("adapterType")).toBe("paperclip_runner");
  expect(query.get("runnerProvider")).toBe("copilot");
});
it("hides Copilot when its runtime adapter is disabled", async () => {
  await act(async () => cache.setQueryData(queryKeys.adapters.availability("company-1", null), state.adapters.map((entry: any) => entry.type === "paperclip_runner" ? { ...entry, disabled: true } : entry)));
  await name();
  expect(document.querySelector('input[value="copilot_runtime"]')).toBeNull();
});
it.each([true, false])("offers Google Antigravity in the ordinary picker while execution is pending (experimental=%s)", async enableNativeRunner => {
  await act(async () => cache.setQueryData(queryKeys.instance.experimentalSettings, { enableNativeRunner }));
  await name();
  const choice = document.querySelector<HTMLInputElement>('input[value="antigravity_runtime"]');
  expect(choice).not.toBeNull();
  expect(choice!.disabled).toBe(false);
  expect(choice!.closest("label")?.textContent).toContain("Google Antigravity");
  expect(choice!.closest("label")?.textContent).toContain("Not available yet");
  expect(choice!.closest("details")).toBeNull();
  await act(async () => choice!.click());
  await click("Configure agent");
  const query = new URL(state.navigate.mock.calls[0][0], "http://local").searchParams;
  expect(query.get("adapterType")).toBe("paperclip_runner");
  expect(query.get("runnerProvider")).toBe("antigravity");
  expect(query.get("setupAgentId")).toBe(agents.create.mock.calls[0][1].setupId);
  expect(agents.update).toHaveBeenCalledWith(agents.create.mock.calls[0][1].setupId, {
    name: "Ada & Co", metadata: { setupAdapterPending: true,
      setupAdapterChoice: { adapterType: "paperclip_runner", runnerProvider: "antigravity", runner: "auto" } },
  }, "company-1");
  expect(agents.create.mock.calls[0][1]).toMatchObject({ adapterType: "process", metadata: { setupAdapterPending: true } });
});
it("hides Google Antigravity when the runtime adapter is disabled", async () => {
  await act(async () => cache.setQueryData(queryKeys.adapters.availability("company-1", null), state.adapters.map((entry: any) => entry.type === "paperclip_runner" ? { ...entry, disabled: true } : entry)));
  await name();
  expect(document.querySelector('input[value="antigravity_runtime"]')).toBeNull();
});
it.each(["grok", "opencode"])("preserves explicit experimental %s creation in Advanced", async provider => {
  await name();
  await act(async () => (document.querySelector("summary") as HTMLElement).click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Experimental harness"]')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>(`[role="option"][data-value="${provider}"]`)!.click());
  await click("Configure agent");
  const query = new URL(state.navigate.mock.calls[0][0], "http://local").searchParams;
  expect(query.get("adapterType")).toBe("paperclip_runner");
  expect(query.get("runnerProvider")).toBe(provider);
  expect(agents.update).toHaveBeenCalledWith(agents.create.mock.calls[0][1].setupId, expect.objectContaining({
    adapterType: "paperclip_runner", adapterConfig: provider === "grok" ? { provider: "acpx", acpxAgent: "grok", model: "grok-4.7" } : { provider: "opencode" },
  }), "company-1");
});
it.each(["gate off", "disabled adapter"])("hides experimental native creation when %s", async reason => {
  await act(async () => {
    if (reason === "gate off") cache.setQueryData(queryKeys.instance.experimentalSettings, { enableNativeRunner: false });
    else cache.setQueryData(queryKeys.adapters.availability("company-1", null), state.adapters.map((entry: any) => entry.type === "paperclip_runner" ? { ...entry, disabled: true } : entry));
  });
  await name();
  expect(document.querySelector('[aria-label="Experimental harness"]')).toBeNull();
  expect(document.querySelectorAll('input[value="codex_local"]')).toHaveLength(1);
});

it("moves Dot out of the harness picker into experimental external invitations", async () => {
  await act(async () => cache.setQueryData(queryKeys.instance.experimentalSettings, { enableNativeRunner: false, enableOpenAiDot: true, enablePublicMcp: true }));
  await name();
  expect(document.querySelector('input[value="openai_dot"]')).toBeNull();
  await click("Back");
  await click("Invite an external agent");
  const dot = [...document.querySelectorAll("button")].find(b => b.textContent?.startsWith("Dot"));
  expect(dot?.disabled).toBe(false);
});

it.each(["Hermes", "Other"])("keeps the existing agent invitation for %s and reuses it after Back", async (kind) => {
  await click("Invite an external agent");
  const select = async () => act(async () => [...document.querySelectorAll("button")].find(b => b.textContent?.startsWith(kind))!.click());
  await select();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(invites.createCompanyInvite).toHaveBeenCalledWith("company-1", { allowedJoinTypes: "agent", humanRole: null, agentMessage: null });
  expect(invites.copy).not.toHaveBeenCalled();
  await click("Copy invitation prompt");
  expect(invites.copy.mock.calls[0][0]).toContain("/api/invites/one-time-token/onboarding.txt");
  await click("Back");
  await select();
  expect(invites.createCompanyInvite).toHaveBeenCalledTimes(1);
});

it("provides a readable prompt and copy retry when the clipboard fails", async () => {
  invites.copy.mockRejectedValueOnce(new Error("Clipboard unavailable"));
  await click("Invite an external agent");
  await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent?.startsWith("Other"))!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  await click("Copy invitation prompt");
  expect(document.body.textContent).toContain("Could not copy automatically");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Setup prompt"]')?.value).toContain("onboarding.txt");
  await click("Try copying again");
  expect(document.body.textContent).not.toContain("Could not copy automatically");
  expect(invites.createCompanyInvite).toHaveBeenCalledTimes(1);
});

it.each([{ enableOpenAiDot: false, enablePublicMcp: true }, { enableOpenAiDot: true, enablePublicMcp: false }])("requires both Dot experimental prerequisites: %j", async flags => {
  await act(async () => cache.setQueryData(queryKeys.instance.experimentalSettings, flags));
  await click("Invite an external agent");
  const dot = [...document.querySelectorAll("button")].find(b => b.textContent?.startsWith("Dot"));
  expect(dot?.disabled).toBe(true);
  expect(document.body.textContent).toContain("Assistant connections (MCP)");
  expect(dotApi.create).not.toHaveBeenCalled();
});

it("copies one scoped Dot prompt, resumes on Back, and trusts only server readiness", async () => {
  const connection = { enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle", agentLifecycleState: "ready", canConfigureConnection: true, binding: null as any };
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "idle" }, approvalId: null, binding: null });
  dotApi.connection.mockImplementation(async () => ({ ...connection }));
  dotApi.pair.mockImplementation(async () => {
    connection.binding = { id: "binding", status: "pairing", connected: false, subscriptionVerified: false, hasPendingChallenge: false };
    return { bindingId: "binding", pairingCode: "test-one-use-code", expiresAt: new Date(Date.now() + 900000).toISOString() };
  });
  await act(async () => cache.setQueryData(queryKeys.instance.experimentalSettings, { enableOpenAiDot: true, enablePublicMcp: true }));
  await click("Invite an external agent");
  const select = async () => act(async () => [...document.querySelectorAll("button")].find(b => b.textContent?.startsWith("Dot"))!.click());
  await select();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  await click("Copy setup prompt");
  expect(invites.copy.mock.calls[0][0]).toContain("test-one-use-code");
  expect(document.body.textContent).toContain("Watching for your Dot");
  expect(document.body.textContent).not.toContain("Your Dot is connected");
  expect(JSON.stringify(cache.getMutationCache().getAll().map(m => m.state.data))).not.toContain("test-one-use-code");
  await click("Back"); await select();
  expect(dotApi.create).toHaveBeenCalledTimes(1);
  expect(dotApi.pair).toHaveBeenCalledTimes(1);
  await click("Copy setup prompt");
  expect(document.querySelector('button[aria-label="Close agent setup"]')).not.toBeNull();
  connection.binding = { ...connection.binding, status: "connected", connected: true };
  await act(async () => cache.invalidateQueries({ queryKey: ["dot-binding", "company-1", "dot-agent"] }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.querySelector('button[aria-label="Close agent setup"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Copy setup prompt");
  expect([...document.querySelectorAll("button")].find(b => b.textContent === "Connecting…")?.disabled).toBe(true);
  connection.binding = { ...connection.binding, subscriptionVerified: true, hasPendingChallenge: true };
  await act(async () => cache.invalidateQueries({ queryKey: ["dot-binding", "company-1", "dot-agent"] }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect([...document.querySelectorAll("button")].find(b => b.textContent === "Confirming connection…")?.disabled).toBe(true);
  expect(document.body.textContent).not.toContain("Done");
  connection.binding = { ...connection.binding, status: "ready", connected: true, subscriptionVerified: true, hasPendingChallenge: false };
  await act(async () => cache.invalidateQueries({ queryKey: ["dot-binding", "company-1", "dot-agent"] }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.body.textContent).toContain("Your Dot is connected");
  expect(document.body.textContent).toContain("Test event confirmed");
  await click("Done");
  expect(state.close).toHaveBeenCalledTimes(1);
});

it("waits for company approval before issuing a Dot capability", async () => {
  dotApi.create.mockResolvedValue({ agent: { id: "pending-dot", status: "pending_approval" }, approvalId: "approval-id", binding: null });
  dotApi.connection.mockResolvedValue({ enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "pending_approval", agentLifecycleState: "pending_approval", canConfigureConnection: false, binding: null });
  await act(async () => cache.setQueryData(queryKeys.instance.experimentalSettings, { enableOpenAiDot: true, enablePublicMcp: true }));
  await click("Invite an external agent");
  await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent?.startsWith("Dot"))!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(document.querySelector('a[href="/approvals/approval-id"]')?.textContent).toBe("Review approval");
  expect(dotApi.pair).not.toHaveBeenCalled();
});

it("allows the scoped Dot invitation on cloud when its prerequisites are enabled", async () => {
  await act(async () => {
    cache.setQueryData(queryKeys.instance.experimentalSettings, { enableOpenAiDot: true, enablePublicMcp: true });
    cache.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: true } });
  });
  await click("Invite an external agent");
  const dot = [...document.querySelectorAll("button")].find(b => b.textContent?.startsWith("Dot"))!;
  expect(dot.disabled).toBe(false);
  await act(async () => dot.click());
  expect(dotApi.create).toHaveBeenCalledWith("company-1");
});

async function openDotSetup() {
  await act(async () => cache.setQueryData(queryKeys.instance.experimentalSettings, { enableOpenAiDot: true, enablePublicMcp: true }));
  await click("Invite an external agent");
  await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent?.startsWith("Dot"))!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}

const pendingDotBinding = (id: string, expiresAt: string) => ({
  id, status: "pairing", connected: false, subscriptionVerified: false, hasPendingChallenge: false, pairingExpiresAt: expiresAt,
});

it.each(["expired", "unavailable"])("automatically replaces an %s saved Dot prompt on opening", async condition => {
  const connection = { enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle", agentLifecycleState: "ready", canConfigureConnection: true,
    binding: pendingDotBinding("saved-binding", new Date(Date.now() + (condition === "expired" ? -60000 : 900000)).toISOString()) };
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "idle" }, approvalId: null, binding: connection.binding });
  dotApi.connection.mockImplementation(async () => ({ ...connection }));
  dotApi.pair.mockImplementation(async () => {
    const expiresAt = new Date(Date.now() + 900000).toISOString();
    connection.binding = pendingDotBinding("fresh-binding", expiresAt);
    return { bindingId: "fresh-binding", pairingCode: "fresh-test-code", expiresAt };
  });
  await openDotSetup();
  expect(dotApi.pair).toHaveBeenCalledExactlyOnceWith("company-1", "dot-agent", "saved-binding");
  expect(document.body.textContent).not.toContain("expired");
  expect(document.body.textContent).not.toContain("Create a new prompt");
  await click("Copy setup prompt");
  expect(invites.copy.mock.calls[0][0]).toContain("fresh-test-code");
  await act(async () => cache.invalidateQueries({ queryKey: ["dot-binding", "company-1", "dot-agent"] }));
  expect(dotApi.pair).toHaveBeenCalledTimes(1);
});

it("renews a Dot prompt that expires while setup stays open", async () => {
  const connection = { enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle", agentLifecycleState: "ready", canConfigureConnection: true, binding: null as any };
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "idle" }, approvalId: null, binding: null });
  dotApi.connection.mockImplementation(async () => ({ ...connection }));
  let generation = 0;
  dotApi.pair.mockImplementation(async () => {
    generation++;
    const expiresAt = new Date(Date.now() + (generation === 1 ? 350 : 900000)).toISOString();
    connection.binding = pendingDotBinding(`binding-${generation}`, expiresAt);
    return { bindingId: connection.binding.id, pairingCode: `code-${generation}`, expiresAt };
  });
  await openDotSetup();
  expect(dotApi.pair).toHaveBeenCalledTimes(1);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(dotApi.pair).toHaveBeenCalledTimes(2);
  expect(dotApi.pair).toHaveBeenLastCalledWith("company-1", "dot-agent", "binding-1");
  expect(document.body.textContent).not.toContain("expired");
  await click("Copy setup prompt");
  expect(invites.copy.mock.calls[0][0]).toContain("code-2");
});

it("checks fresh connection state before renewing a cached pending Dot invitation", async () => {
  const staleBinding = pendingDotBinding("saved-binding", new Date(Date.now() - 60000).toISOString());
  cache.setQueryData(["dot-binding", "company-1", "dot-agent"], {
    enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle", agentLifecycleState: "ready", canConfigureConnection: true, binding: staleBinding,
  });
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "idle" }, approvalId: null, binding: staleBinding });
  dotApi.connection.mockResolvedValue({ enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle", agentLifecycleState: "ready", canConfigureConnection: true,
    binding: { ...staleBinding, status: "ready", connected: true, subscriptionVerified: true } });
  await openDotSetup();
  expect(dotApi.connection).toHaveBeenCalled();
  expect(dotApi.pair).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Your Dot is connected");
});

it("offers a retry after automatic renewal fails without rotating on every poll", async () => {
  const connection = { enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle", agentLifecycleState: "ready", canConfigureConnection: true,
    binding: pendingDotBinding("saved-binding", new Date(Date.now() - 60000).toISOString()) };
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "idle" }, approvalId: null, binding: connection.binding });
  dotApi.connection.mockImplementation(async () => ({ ...connection }));
  dotApi.pair.mockRejectedValueOnce(new Error("Connection interrupted. Try again."));
  await openDotSetup();
  expect(dotApi.pair).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Connection interrupted. Try again.");
  await act(async () => cache.invalidateQueries({ queryKey: ["dot-binding", "company-1", "dot-agent"] }));
  expect(dotApi.pair).toHaveBeenCalledTimes(1);
  dotApi.pair.mockImplementation(async () => {
    const expiresAt = new Date(Date.now() + 900000).toISOString();
    connection.binding = pendingDotBinding("retried-binding", expiresAt);
    return { bindingId: "retried-binding", pairingCode: "retried-code", expiresAt };
  });
  await click("Try again");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(dotApi.pair).toHaveBeenCalledTimes(2);
  await click("Copy setup prompt");
  expect(invites.copy.mock.calls[0][0]).toContain("retried-code");
});


it("does not let an older window renew another window's fresh Dot prompt", async () => {
  const connection = { enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle", agentLifecycleState: "ready", canConfigureConnection: true, binding: null as any };
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "idle" }, approvalId: null, binding: null });
  dotApi.connection.mockImplementation(async () => ({ ...connection }));
  dotApi.pair.mockImplementation(async () => {
    const expiresAt = new Date(Date.now() + 350).toISOString();
    connection.binding = pendingDotBinding("old-window-binding", expiresAt);
    return { bindingId: connection.binding.id, pairingCode: "old-code", expiresAt };
  });
  await openDotSetup();
  connection.binding = pendingDotBinding("other-window-binding", new Date(Date.now() + 900000).toISOString());
  await act(async () => cache.invalidateQueries({ queryKey: ["dot-binding", "company-1", "dot-agent"] }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 420)); });
  expect(dotApi.pair).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Create a new prompt");
  expect(document.body.textContent).not.toContain("Copy setup prompt");
});

it("retries the event test after Dot connects during a failed prompt renewal", async () => {
  const connection = { enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle", agentLifecycleState: "ready", canConfigureConnection: true,
    binding: pendingDotBinding("saved-binding", new Date(Date.now() - 60000).toISOString()) as any };
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "idle" }, approvalId: null, binding: connection.binding });
  dotApi.connection.mockImplementation(async () => ({ ...connection }));
  dotApi.pair.mockRejectedValueOnce(new Error("Dot already connected."));
  await openDotSetup();
  connection.binding = { ...connection.binding, status: "connected", connected: true, subscriptionVerified: true,
    challengeExpiresAt: new Date(Date.now() - 1000).toISOString() };
  await act(async () => cache.invalidateQueries({ queryKey: ["dot-binding", "company-1", "dot-agent"] }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.body.textContent).not.toContain("Dot already connected.");
  await click("Retry test event");
  expect(dotApi.retry).toHaveBeenCalledExactlyOnceWith("company-1", "dot-agent", "saved-binding");
  expect(dotApi.pair).toHaveBeenCalledTimes(1);
});


it.each(["preparing", "verifying"])("prepares the Dot prompt while the hire is %s", async agentLifecycleState => {
  const connection = { enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "paused",
    agentLifecycleState, canConfigureConnection: true, binding: null as any };
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "paused" }, approvalId: null, binding: null });
  dotApi.connection.mockImplementation(async () => ({ ...connection }));
  dotApi.pair.mockImplementation(async () => {
    connection.binding = pendingDotBinding("binding", new Date(Date.now() + 900000).toISOString());
    return { bindingId: "binding", pairingCode: "setup-hire-code", expiresAt: connection.binding.pairingExpiresAt };
  });
  await openDotSetup();
  expect(dotApi.pair).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("Resume this agent");
  await click("Copy setup prompt");
  expect(invites.copy.mock.calls[0][0]).toContain("setup-hire-code");
});

it("does not prepare a Dot capability for a real paused agent", async () => {
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "paused" }, approvalId: null, binding: null });
  dotApi.connection.mockResolvedValue({ enabled: true, resourceUrl: "https://paperclip.example/mcp/runner",
    agentStatus: "paused", agentLifecycleState: "paused", canConfigureConnection: false, binding: null });
  await openDotSetup();
  expect(dotApi.pair).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Resume this agent before connecting Dot.");
});

it("keeps watching after the event check until hire verification completes", async () => {
  const connection = { enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "paused",
    agentLifecycleState: "verifying", canConfigureConnection: true, binding: null as any };
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "paused" }, approvalId: null, binding: null });
  dotApi.connection.mockImplementation(async () => ({ ...connection }));
  dotApi.pair.mockImplementation(async () => {
    connection.binding = pendingDotBinding("binding", new Date(Date.now() + 900000).toISOString());
    return { bindingId: "binding", pairingCode: "setup-hire-code", expiresAt: connection.binding.pairingExpiresAt };
  });
  await openDotSetup();
  connection.binding = { ...connection.binding, status: "ready", connected: true, subscriptionVerified: true, hasPendingChallenge: false };
  await act(async () => cache.invalidateQueries({ queryKey: ["dot-binding", "company-1", "dot-agent"] }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.body.textContent).not.toContain("Your Dot is connected");
  expect(document.body.textContent).toContain("Test event confirmed: complete");
  expect(document.body.textContent).toContain("Your Dot confirmed the test event. Paperclip is finishing agent setup.");
  const finishing = Array.from(document.querySelectorAll("button")).find(button => button.textContent?.includes("Finishing setup…"));
  expect(finishing?.disabled).toBe(true);
  connection.agentLifecycleState = "ready";
  connection.agentStatus = "idle";
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2750)); });
  expect(document.body.textContent).toContain("Your Dot is connected");
  await click("Done");
  expect(state.close).toHaveBeenCalledTimes(1);
});

it("keeps completed checks but shows a pause blocker for a paired paused Dot", async () => {
  dotApi.create.mockResolvedValue({ agent: { id: "dot-agent", status: "paused" }, approvalId: null, binding: null });
  dotApi.connection.mockResolvedValue({ enabled: true, resourceUrl: "https://paperclip.example/mcp/runner",
    agentStatus: "paused", agentLifecycleState: "paused", canConfigureConnection: false,
    binding: { ...pendingDotBinding("binding", new Date(Date.now() + 900000).toISOString()),
      status: "ready", connected: true, subscriptionVerified: true, hasPendingChallenge: false } });
  await openDotSetup();
  expect(document.body.textContent).toContain("Test event confirmed: complete");
  expect(document.body.textContent).toContain("Resume this agent before connecting Dot.");
  expect(document.body.textContent).not.toContain("Finishing setup…");
  expect(document.body.textContent).not.toContain("Paperclip is finishing agent setup.");
  const blocked = Array.from(document.querySelectorAll("button")).find(button => button.textContent?.includes("Agent unavailable"));
  expect(blocked?.disabled).toBe(true);
  expect(dotApi.pair).not.toHaveBeenCalled();
});
