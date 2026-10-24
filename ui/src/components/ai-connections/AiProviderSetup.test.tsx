// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { AiProviderSetup } from "./AiProviderSetup";
import { aiConnectionsApi } from "@/api/ai-connections";
import { TooltipProvider } from "@/components/ui/tooltip";
import { aiProviderSetupPreset } from "@paperclipai/shared";
import type { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

let credentialProps: ComponentProps<typeof AiConnectionCredentialStep> | undefined;
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { create: vi.fn(async () => ({ connectionId: "connection", grantId: "grant" })), list: vi.fn(async () => ({ currentUserId: "owner", connections: [], canManageConnections: true })), probeRoutingModels: vi.fn(async () => ({ models: [{ id: "qwen3-coder:30b" }, { id: "llama3.2:latest" }] })) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("./AiConnectionCredentialStep", () => ({ AiConnectionCredentialStep: (props: ComponentProps<typeof AiConnectionCredentialStep>) => { credentialProps = props; return <div>Existing credential flow</div>; } }));

it("reconnects an older OpenRouter account without adding routing metadata", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  const onComplete = vi.fn();
  const account = { id: "connection", grantId: "grant", companyId: "company", provider: "openrouter", method: "api_key", name: "Existing OpenRouter", ownership: "personal", ownerUserId: "owner", isDefault: true, status: "needs_attention" } as const;
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" reconnect={account} onCancel={() => {}} onComplete={onComplete} /></QueryClientProvider>));
    expect(container.textContent).toContain("Existing credential flow");
    expect(credentialProps).toMatchObject({ connectionId: account.id, provider: "openrouter", initialMethod: "api_key", fixedMethod: true });
    credentialProps!.onComplete({ connectionId: account.id, grantId: account.grantId, method: "api_key" });
    expect(onComplete).toHaveBeenCalledWith({ provider: "openrouter", method: "api_key", mode: "delegated", connectionId: account.id, grantId: account.grantId });
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

const providerSources = ["openrouter", "bedrock", "responses-api", "messages-api", "chat-completions-api", "local"];
it("shows advanced providers directly when entered from advanced connection mode", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: true, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" advancedOnly onCancel={() => {}} onComplete={() => {}} /></QueryClientProvider>));
    const choices = Array.from(container.querySelectorAll("button[aria-label]")).map(button => button.getAttribute("aria-label"));
    expect(choices).toEqual(["OpenRouter", "Amazon Bedrock", "Custom gateway", "Local endpoint"]);
    expect(container.querySelector("details")).toBeNull();
  } finally {
    await act(async () => root.unmount()); client.clear();
  }
});

it.each(providerSources)("opens %s directly with shared access folded under Advanced", async source => {
  const preset = aiProviderSetupPreset(source)!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: true, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], [{ id: "agent", name: "Nova" }]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onCancel = vi.fn();
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><AiProviderSetup companyId="company" initialProvider={preset.provider} initialProtocol={preset.protocol} providerLabel={preset.label} onCancel={onCancel} onComplete={() => {}} /></TooltipProvider></QueryClientProvider>));
    expect(container.textContent).not.toContain("Connect a model provider");
    expect(container.textContent).toContain("Connects for everyone in your organization, available to all agents.");
    expect(container.querySelector('[role="radio"]')).toBeNull();
    const change = Array.from(container.querySelectorAll('button')).find(b => b.textContent === "Change")!;
    expect(change.getAttribute("aria-expanded")).toBe("false");
    await act(async () => change.click());
    const radio = (text: string) => Array.from(container.querySelectorAll('[role="radio"]')).find(b => b.textContent?.includes(text)) as HTMLButtonElement;
    expect(radio("Any human in the organization").getAttribute("aria-checked")).toBe("true");
    expect(radio("Any agent").getAttribute("aria-checked")).toBe("true");
    await act(async () => radio("Just me").click());
    expect(container.textContent).toContain("Connects as you, available to all agents.");
    await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === "Back")!.click());
    expect(onCancel).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount()); container.remove(); client.clear();
  }
});

it("saves the default organization grant and all-agent installation from the direct connect screen", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: true, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" initialProvider="openrouter" onCancel={() => {}} onComplete={() => {}} /></QueryClientProvider>));
    const input = container.querySelector('input[aria-label="API key"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(aiConnectionsApi.create).toHaveBeenCalledWith("company", expect.objectContaining({ ownership: "shared", allAgents: true, agentIds: [], apiKey: "fixture-key", routing: expect.objectContaining({ kind: "openrouter" }) }));
  } finally {
    await act(async () => root.unmount()); client.clear();
  }
});


it("allows an ordinary member to save a personal gateway before the agent exists", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: false, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  const root = createRoot(container);
  const onComplete = vi.fn();
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" initialProvider="openrouter" onCancel={() => {}} onComplete={onComplete} /></QueryClientProvider>));
    const input = container.querySelector('input[aria-label="API key"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "member-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const connect = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(aiConnectionsApi.create).toHaveBeenCalledWith("company", expect.objectContaining({ ownership: "personal", allAgents: false, agentIds: [], apiKey: "member-key" }));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mode: "delegated", connectionId: "connection", grantId: "grant" }));
  } finally {
    await act(async () => root.unmount()); client.clear();
  }
});


it("drops a probe reply that arrives after the endpoint URL changed", async () => {
  let resolveProbe: ((value: { models: Array<{ id: string }> }) => void) | undefined;
  vi.mocked(aiConnectionsApi.probeRoutingModels).mockImplementationOnce(
    () => new Promise((resolve) => { resolveProbe = resolve; }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: true, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><AiProviderSetup companyId="company" initialProvider="local" initialProtocol="chat" onCancel={() => {}} onComplete={() => {}} /></TooltipProvider></QueryClientProvider>));
    await expandAccessDefaults(container);
    await act(async () => setInputValue(container.querySelector('input[aria-label="Provider URL"]')!, "http://localhost:11434/v1"));
    await act(async () => setInputValue(container.querySelector('input[aria-label="API key"]')!, "fixture-key"));
    await act(async () => (Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Fetch models") as HTMLButtonElement).click());
    await act(async () => setInputValue(container.querySelector('input[aria-label="Provider URL"]')!, "http://localhost:11500/v1"));
    await act(async () => resolveProbe!({ models: [{ id: "qwen3-coder:30b" }] }));
    await vi.waitFor(() => expect(fetchModelsSettled(container)).toBe(true));
    expect((container.querySelector('input[aria-label="Model IDs"]') as HTMLInputElement).value).toBe("");
  } finally {
    await act(async () => root.unmount()); container.remove(); client.clear();
  }
});

/** The status line only renders once the mutation has settled, success or error. */
function fetchModelsSettled(container: HTMLElement): boolean {
  return Boolean(container.querySelector('[role="status"]')) || Boolean(container.querySelector('[role="alert"]'));
}

it.each(["google", "openai", "anthropic", "xai"] as const)("allows an ordinary member to connect a personal %s account before an agent exists", async provider => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: false, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  const root = createRoot(container);
  credentialProps = undefined;
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" initialProvider={provider} onCancel={() => {}} onComplete={() => {}} /></QueryClientProvider>));
    expect(credentialProps).toMatchObject({ provider, ownership: "personal", allAgents: false, agentIds: [], disabled: false });
  } finally {
    await act(async () => root.unmount()); client.clear();
  }
});

async function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function expandAccessDefaults(container: HTMLElement) {
  const change = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Change")!;
  await act(async () => change.click());
}

it("fills the model list from the endpoint before the local connection is saved", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: true, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><AiProviderSetup companyId="company" initialProvider="local" initialProtocol="chat" onCancel={() => {}} onComplete={() => {}} /></TooltipProvider></QueryClientProvider>));
    await expandAccessDefaults(container);
    await act(async () => setInputValue(container.querySelector('input[aria-label="Provider URL"]')!, "http://localhost:11434/v1"));
    await act(async () => setInputValue(container.querySelector('input[aria-label="API key"]')!, "fixture-key"));
    const fetchButton = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Fetch models") as HTMLButtonElement;
    expect(fetchButton.disabled).toBe(false);
    await act(async () => fetchButton.click());
    expect(aiConnectionsApi.probeRoutingModels).toHaveBeenCalledWith("company", {
      routing: expect.objectContaining({ kind: "local", protocol: "chat", auth: "bearer", baseUrl: "http://localhost:11434/v1" }),
      apiKey: "fixture-key",
    });
    expect((container.querySelector('input[aria-label="Model IDs"]') as HTMLInputElement).value).toBe("qwen3-coder:30b, llama3.2:latest");
    expect(container.textContent).toContain("Found 2 models.");
  } finally {
    await act(async () => root.unmount()); container.remove(); client.clear();
  }
});

it("disables fetching until the local endpoint URL is present and surfaces probe failures", async () => {
  vi.mocked(aiConnectionsApi.probeRoutingModels).mockRejectedValueOnce(new Error("The endpoint rejected the credentials."));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: true, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><AiProviderSetup companyId="company" initialProvider="local" initialProtocol="chat" onCancel={() => {}} onComplete={() => {}} /></TooltipProvider></QueryClientProvider>));
    await expandAccessDefaults(container);
    await act(async () => setInputValue(container.querySelector('input[aria-label="API key"]')!, "fixture-key"));
    const fetchButton = () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Fetch models") as HTMLButtonElement;
    expect(fetchButton().disabled).toBe(true);
    await act(async () => setInputValue(container.querySelector('input[aria-label="Provider URL"]')!, "http://localhost:11434/v1"));
    expect(fetchButton().disabled).toBe(false);
    await act(async () => fetchButton().click());
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("The endpoint rejected the credentials."));
    expect((container.querySelector('input[aria-label="Model IDs"]') as HTMLInputElement).value).toBe("");
  } finally {
    await act(async () => root.unmount()); container.remove(); client.clear();
  }
});
