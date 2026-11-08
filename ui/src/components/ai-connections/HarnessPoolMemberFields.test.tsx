// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(item => item.textContent?.includes(label))!;
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
  expect(document.body.textContent).not.toContain("Paperclip Runner");
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

it("offers the ordinary OpenCode effort options and retains a supported effort when changing models", async () => {
  mocks.accounts.mockResolvedValue({ currentUserId: "owner", canManageConnections: true, connections: [account("First", { provider: "openrouter", method: "api_key" })] });
  await mount({ ...draft(), harness: { type: "opencode" }, connection: { ...binding("First"), provider: "openrouter", method: "api_key" } });
  await open("Thinking effort"); await choose("Max"); expect(latest.effort).toBe("max");
  await open("Model"); await choose("GPT-6 Luna"); expect(latest.effort).toBe("max");
});
