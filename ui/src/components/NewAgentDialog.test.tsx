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
async function name() {
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Ada & Co");
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
it("offers native Codex, Claude ACPX, and OpenCode runners", async () => {
  await name();
  await act(async () =>
    (
      document.querySelector(
        'input[value="paperclip_runner"]',
      ) as HTMLInputElement
    ).click(),
  );
  const options = [...document.querySelectorAll("option")].map(
    (option) => option.textContent,
  );
  expect(options).toContain("Codex (app server)");
  expect(options).toContain("Claude (ACPX)");
  expect(options).toContain("OpenCode");
  expect(options.join(" ")).not.toContain("ACPX Codex");
});

it.each([false, undefined])(
  "hides the runner unless explicitly enabled (%s)",
  async (enableNativeRunner) => {
    await act(async () => {
      cache.setQueryData(queryKeys.instance.experimentalSettings, {
        enableNativeRunner,
      });
    });
    await name();
    expect(
      document.querySelector('input[value="paperclip_runner"]'),
    ).toBeNull();
    expect(document.querySelector('input[value="codex_local"]')).not.toBeNull();
  },
);

it.each([true, false, undefined])("gates the Cloud native runner on explicit enablement (%s)", async (enableNativeRunner) => {
  await act(async () => {
    cache.setQueryData(queryKeys.instance.experimentalSettings, { enableNativeRunner });
    cache.setQueryData(queryKeys.health, {
      status: "ok",
      cloud: { managed: true },
    });
    cache.setQueryData(
      queryKeys.adapters.all,
      [
        "claude_local",
        "codex_local",
        "opencode_local",
        "cursor",
        "cursor_cloud",
        "gemini_local",
        "grok_local",
        "kimi_local",
        "pi_local",
        "hermes_local",
        "paperclip_runner",
      ].map((type) => ({ type, loaded: true })),
    );
  });
  await name();
  expect(
    [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(
      (input) => input.value,
    ),
  ).toEqual(["claude_local", "codex_local", "opencode_local", "grok_local", ...(enableNativeRunner ? ["paperclip_runner"] : [])]);
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[value="grok_local"]')!.click(),
  );
  await click("Configure agent");
  const query = new URL(state.navigate.mock.calls[0][0], "http://local").searchParams;
  expect(query.get("adapterType")).toBe("grok_local");
  expect(query.get("name")).toBe("Ada & Co");
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
  connection.agentLifecycleState = "ready";
  connection.agentStatus = "idle";
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2750)); });
  expect(document.body.textContent).toContain("Your Dot is connected");
  await click("Done");
  expect(state.close).toHaveBeenCalledTimes(1);
});
