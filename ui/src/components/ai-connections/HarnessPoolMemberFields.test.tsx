// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AiConnectionSelect } from "./AiConnectionSelect";
import { HarnessPoolMemberFields, type HarnessPoolMemberDraft } from "./HarnessPoolMemberFields";
import type { AiProviderSetup } from "./AiProviderSetup";

const mocks = vi.hoisted(() => ({ accounts: vi.fn(), models: vi.fn(), setDefault: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { list: mocks.accounts, setDefault: mocks.setDefault } }));
vi.mock("@/api/agents", () => ({ agentsApi: { adapterModels: mocks.models } }));
vi.mock("@/adapters/use-disabled-adapters", () => ({ useDisabledAdaptersSync: () => new Set<string>() }));
vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));
let setup: ComponentProps<typeof AiProviderSetup> | undefined;
vi.mock("./AiProviderSetup", () => ({ AiProviderSetup: (props: ComponentProps<typeof AiProviderSetup>) => { setup = props; return <div>Account sign-in</div>; } }));

const ids = Object.fromEntries(["First", "Second", "Connected"].map(name => [name, { id: crypto.randomUUID(), grantId: crypto.randomUUID() }]));
const account = (name: string, overrides: Partial<AiManagedConnectionSummary> = {}): AiManagedConnectionSummary => ({
  ...ids[name]!, companyId: "company", name, provider: "openai", method: "subscription", ownership: "shared", status: "connected", isDefault: false, ...overrides,
});
const binding = (name: string) => ({ mode: "shared" as const, connectionId: ids[name]!.id, grantId: ids[name]!.grantId, provider: "openai" as const, method: "subscription" as const });
const draft = (connection = binding("First")): HarnessPoolMemberDraft => ({ id: "member", harness: { type: "codex" }, connection, model: "gpt-6-sol", effort: "high" });
let root: Root, host: HTMLDivElement, client: QueryClient;
let latest: HarnessPoolMemberDraft;

async function settle() { for (let i = 0; i < 6; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); } }
async function open(label: string) {
  const trigger = host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  expect(trigger).toBeTruthy();
  flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await settle();
}
async function choose(label: string) {
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  const option = options.find(item => item.textContent === label) ?? options.find(item => item.textContent?.includes(label))!;
  expect(option, label).toBeTruthy(); flushSync(() => option.click()); await settle();
}
async function mount(initial = draft()) {
  function Form() {
    const [member, setMember] = useState(initial);
    latest = member;
    return <HarnessPoolMemberFields companyId="company" member={member} readOnly={false} onChange={patch => setMember(previous => ({ ...previous, ...patch }))} />;
  }
  flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><Form /></TooltipProvider></QueryClientProvider>)); await settle();
}
beforeEach(() => {
  vi.clearAllMocks(); setup = undefined;
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [account("First"), account("Second")] });
  mocks.models.mockResolvedValue([{ id: "gpt-6-sol", label: "GPT-6 Sol" }, { id: "gpt-6-luna", label: "GPT-6 Luna" }]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); host.remove(); });

it("uses the account and model selectors, resets stale model/effort on account change and scopes discovery", async () => {
  await mount(); await open("Connection");
  expect(document.body.textContent).not.toContain("Responsible user’s default");
  await choose("Second");
  expect(latest).toMatchObject({ connection: binding("Second"), model: "", effort: undefined });
  expect(mocks.models).toHaveBeenLastCalledWith("company", "codex_local", expect.objectContaining({ aiConnection: binding("Second") }));
  await open("Model"); await choose("GPT-6 Luna");
  expect(latest.model).toBe("gpt-6-luna");
  await open("Thinking effort"); await choose("High");
  expect(latest.effort).toBe("high");
});

it("connects an account from an empty pool member without changing the user's default", async () => {
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [] });
  await mount({ id: "member", harness: { type: "codex" }, model: "" });
  await open("Connection"); await choose("Connect an account");
  expect(setup).toMatchObject({ companyId: "company", initialProvider: "openai" });
  flushSync(() => setup!.onComplete(binding("Connected"))); await settle();
  expect(latest.connection).toEqual(binding("Connected"));
  expect(mocks.setDefault).not.toHaveBeenCalled();
});

it("reconnects the selected explicit account and preserves its model", async () => {
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [account("First", { status: "needs_attention" })] });
  await mount();
  const reconnect = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Reconnect account")!;
  expect(reconnect).toBeTruthy(); flushSync(() => reconnect.click()); await settle();
  expect(setup?.reconnect?.id).toBe(ids.First!.id);
  flushSync(() => setup!.onComplete(binding("First"))); await settle();
  expect(latest.model).toBe("gpt-6-sol"); expect(latest.effort).toBe("high");
  expect(mocks.setDefault).not.toHaveBeenCalled();
});

it("uses the ordinary harness picker and clears an incompatible account when switching", async () => {
  await mount(); await open("Harness");
  expect(Array.from(document.querySelectorAll('[role="option"]')).map(option => option.textContent).join(" ")).not.toContain("Paperclip Runner");
  await choose("Claude Code");
  expect(latest).toMatchObject({ harness: { type: "claude_code" }, connection: undefined, model: "", effort: undefined });
});

it("uses gateway model aliases and does not load an unrelated generic catalog", async () => {
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [account("First", { method: "api_key", routing: { kind: "gateway", protocol: "responses", auth: "bearer", baseUrl: "https://gateway.example/v1", models: [{ id: "smart", label: "Smart alias" }] } })] });
  await mount({ ...draft(), connection: { ...binding("First"), method: "api_key" } });
  expect(mocks.models).not.toHaveBeenCalled();
  await open("Model"); await choose("Smart alias"); expect(latest.model).toBe("smart");
});

it("shows model discovery failures and can retry", async () => {
  mocks.models.mockRejectedValue(new Error("Catalog offline"));
  await mount(); expect(host.textContent).toContain("Catalog offline");
  mocks.models.mockResolvedValue([{ id: "recovered", label: "Recovered model" }]);
  const retry = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("Retry"))!;
  expect(retry).toBeTruthy(); flushSync(() => retry.click()); await settle();
  await open("Model"); await choose("Recovered model"); expect(latest.model).toBe("recovered");
});

it("keeps a late response from the previous account out of the current model choices", async () => {
  let finishFirst!: (models: { id: string; label: string }[]) => void;
  mocks.models.mockImplementation((_company, _adapter, options) => options.aiConnection.connectionId === ids.First!.id
    ? new Promise(resolve => { finishFirst = resolve; })
    : Promise.resolve([{ id: "second-model", label: "Second account model" }]));
  await mount(); await open("Connection"); await choose("Second");
  finishFirst([{ id: "first-model", label: "First account model" }]); await settle();
  await open("Model");
  const options = Array.from(document.querySelectorAll('[role="option"]')).map(option => option.textContent);
  expect(options).toContain("Second account model"); expect(options).not.toContain("First account model");
});

it("refreshes the selected account's models through the ordinary model control", async () => {
  await mount(); await open("Model");
  mocks.models.mockResolvedValue([{ id: "refreshed-model", label: "Refreshed account model" }]);
  const refresh = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Refresh models")!;
  expect(refresh).toBeTruthy(); flushSync(() => refresh.click()); await settle();
  expect(mocks.models).toHaveBeenLastCalledWith("company", "codex_local", expect.objectContaining({ refresh: true, aiConnection: binding("First") }));
  await choose("Refreshed account model"); expect(latest.model).toBe("refreshed-model");
});

it("only allows clearing unsupported saved OpenCode effort and keeps new model selections automatic", async () => {
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [account("First", { provider: "openrouter", method: "api_key" })] });
  await mount({ ...draft(), harness: { type: "opencode" }, connection: { ...binding("First"), provider: "openrouter", method: "api_key" } });
  await open("Thinking effort");
  expect(Array.from(document.querySelectorAll('[role="option"]')).map(option => option.textContent)).toEqual(["Auto"]);
  await choose("Auto"); expect(latest.effort).toBeUndefined();
  await open("Model"); await choose("GPT-6 Luna"); expect(latest.effort).toBeUndefined();
  expect(host.querySelector('[aria-label="Thinking effort"]')).toBeNull();
});

it("selects an expired explicit account for repair from an empty member", async () => {
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [account("First", { status: "expired" })] });
  await mount({ id: "member", harness: { type: "codex" }, model: "" });
  await open("Connection"); await choose("First");
  expect(latest.connection).toEqual(binding("First"));
  const reconnect = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Reconnect account")!;
  expect(reconnect).toBeTruthy(); flushSync(() => reconnect.click()); await settle();
  expect(setup?.reconnect?.id).toBe(ids.First!.id);
  flushSync(() => setup!.onComplete(binding("First"))); await settle();
  expect(latest.connection).toEqual(binding("First"));
  expect(mocks.setDefault).not.toHaveBeenCalled();
});

it.each([
  { status: "revoked" as const },
  { status: "expired" as const, unavailableReason: "Access was removed" },
])("keeps unavailable explicit accounts disabled (%j)", async problem => {
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [account("First", problem)] });
  await mount({ id: "member", harness: { type: "codex" }, model: "" });
  await open("Connection"); await choose("First");
  expect(latest.connection).toBeUndefined();
});


it.each([
  { harness: "claude_code" as const, provider: "anthropic" as const },
  { harness: "codex" as const, provider: "openai" as const },
])("only offers $provider accounts for the $harness pool harness", async ({ harness, provider }) => {
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [
    account("First", { provider: "openrouter", method: "api_key", routing: { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] } }),
    account("Second", { provider }),
  ] });
  await mount({ id: "member", harness: { type: harness }, model: "" });
  await open("Connection");
  const options = [...document.querySelectorAll('[role="option"]')];
  expect(options.some(option => option.textContent?.includes("First"))).toBe(false);
  await choose("Second");
  expect(latest.connection).toMatchObject({ connectionId: ids.Second!.id, provider });
});

it.each([
  { harness: "claude_code" as const, provider: "anthropic" as const },
  { harness: "codex" as const, provider: "openai" as const },
])("marks a saved OpenRouter account incompatible for the $harness pool harness", async ({ harness, provider }) => {
  const saved = { ...binding("First"), provider: "openrouter" as const, method: "api_key" as const };
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [
    account("First", { provider: "openrouter", method: "api_key", routing: { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] } }),
    account("Second", { provider }),
  ] });
  await mount({ id: "member", harness: { type: harness }, connection: saved, model: "" });
  await open("Connection");
  const option = [...document.querySelectorAll('[role="option"]')].find(item => item.textContent?.includes("First"));
  expect(option?.getAttribute("aria-disabled")).toBe("true");
  expect(option?.textContent).toContain("Incompatible");
  await choose("Second");
  expect(latest.connection).toMatchObject({ connectionId: ids.Second!.id, provider });
});

it.each([false, true])("keeps OpenRouter selectable for OpenCode pool members (routing=%s)", async routed => {
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [
    account("First", { provider: "openrouter", method: "api_key", ...(routed ? { routing: { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] } as const } : {}) }),
  ] });
  await mount({ id: "member", harness: { type: "opencode" }, model: "" });
  await open("Connection"); await choose("First");
  expect(latest.connection).toMatchObject({ connectionId: ids.First!.id, provider: "openrouter", method: "api_key" });
});

it.each(["claude_local", "codex_local"])("preserves ordinary routed OpenRouter selection for %s outside pools", async adapterType => {
  const onChange = vi.fn();
  flushSync(() => root.render(<AiConnectionSelect adapterType={adapterType} requirement={{ companyId: "company", provider: adapterType === "claude_local" ? "anthropic" : "openai" }}
    currentUserId="owner" agentId="agent" agentName="Agent" onConnect={() => {}} onChange={onChange}
    connections={[account("First", { provider: "openrouter", method: "api_key", routing: { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] } })]} />));
  await open("Connection"); await choose("First");
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ connectionId: ids.First!.id, provider: "openrouter", method: "api_key" }));
});

it("preserves historical runner omission until explicitly changed and edits legacy engine", async () => {
  await mount({ ...draft(), harness: { type: "claude_code" }, connection: undefined });
  expect(latest.runner).toBeUndefined();
  await open("Runner"); await choose("Legacy");
  expect(latest.runner).toBe("legacy");
  await open("Execution engine"); await choose("Claude CLI");
  expect(latest.adapterConfig).toMatchObject({ engine: "cli" });
  expect(host.querySelector('[aria-label="Permissions"]')).toBeNull();
  expect(host.querySelector('[aria-label="Permissions"]')).toBeNull();
  await open("Execution engine"); await choose("ACP");
  expect(latest.adapterConfig).toMatchObject({ engine: "acp" });
  expect(host.querySelector('[aria-label="ACP session mode"]')).toBeTruthy();
  await open("Runner"); await choose("Paperclip Runner");
  expect(latest.runner).toBe("paperclip");
  expect(host.querySelector('[aria-label="Execution engine"]')).toBeNull();
  expect(host.querySelector('[aria-label="Runner lifecycle"]')).toBeTruthy();
  expect(host.textContent).not.toContain("instructions file");
});

it("edits the Codex engine and clears incompatible settings when choosing the native runner", async () => {
  await mount({ ...draft(), runner: "legacy", adapterConfig: { engine: "cli", fastMode: true } });
  expect(host.querySelector('[aria-label="Execution engine"]')?.textContent).toContain("Codex CLI");
  await open("Execution engine"); await choose("ACP");
  expect(latest.adapterConfig).toMatchObject({ engine: "acp", fastMode: true });
  await open("ACP session mode"); await choose("One-shot");
  expect(latest.adapterConfig?.mode).toBe("oneshot");
  await open("Runner"); await choose("Paperclip Runner");
  expect(latest.adapterConfig).toBeUndefined();
  expect(latest.connection).toEqual(binding("First"));
  expect(latest.model).toBe("gpt-6-sol");
});

it("uses the native provider permission capability and keeps legacy-only controls hidden", async () => {
  await mount({ ...draft(), harness: { type: "claude_code" }, runner: "paperclip", connection: undefined });
  expect(host.textContent).not.toContain("Chrome");
  expect(host.textContent).not.toContain("Max turns per run");
  await open("Permission mode"); await choose("Allow Paperclip reads");
  expect(latest.adapterConfig).toMatchObject({ acpxPermissionMode: "approve-reads" });
  expect(latest.adapterConfig?.permissionMode).toBeUndefined();
});

it("offers ACP settings for the default legacy Claude engine and confirms removing them", async () => {
  await mount({ ...draft(), harness: { type: "claude_code" }, runner: "legacy", connection: undefined });
  expect(host.querySelector('[aria-label="ACP session mode"]')).toBeTruthy();
  await open("Permissions"); await choose("Approve reads");
  expect(latest.adapterConfig?.permissionMode).toBe("approve-reads");
  await open("Execution engine"); await choose("Claude CLI");
  expect(latest.adapterConfig?.permissionMode).toBe("approve-reads");
  flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Switch to CLI")!.click());
  expect(latest.adapterConfig).toEqual({engine:"cli"});
  expect(host.querySelector('[aria-label="Permissions"]')).toBeNull();
});

it.each([undefined, false])("matches actual Codex bypass policy for saved setting %s", async dangerouslyBypassApprovalsAndSandbox => {
  await mount({ ...draft(), runner:"legacy", adapterConfig:{dangerouslyBypassApprovalsAndSandbox} });
  const toggle=host.querySelector('[aria-label="Bypass approvals and sandbox"]');
  expect(toggle?.getAttribute("aria-checked")).toBe(String(dangerouslyBypassApprovalsAndSandbox !== false));
});
