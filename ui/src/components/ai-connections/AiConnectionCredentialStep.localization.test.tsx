// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

const createConnection = vi.hoisted(() => vi.fn());
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { create: createConnection } }));
vi.mock("@/components/new-agent/AgentProviderConnection", () => ({ AgentProviderConnection: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  createConnection.mockResolvedValue({ connectionId: "created-id", grantId: "created-grant" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  host.remove();
  await i18n.changeLanguage("en");
});

it("preserves the editable account name and key across en/ru/en and submits unchanged credentials", async () => {
  const complete = vi.fn();
  const cancel = vi.fn();
  await act(async () => root.render(<QueryClientProvider client={cache}>
    <AiConnectionCredentialStep companyId="company-1" provider="openrouter" name="Original name" ownership="personal" agentIds={["agent-42"]} allAgents={false} onComplete={complete} onCancel={cancel} />
  </QueryClientProvider>));
  const inputs = [...host.querySelectorAll("input")];
  const name = inputs.find((input) => input.value === "Original name")!;
  const key = inputs.find((input) => input.type === "password")!;
  // A supplied account name is data even before the user edits the field.
  for (const locale of ["ru", "en"]) {
    await act(async () => { await i18n.changeLanguage(locale); });
    expect(name.value).toBe("Original name");
    expect(createConnection).not.toHaveBeenCalled();
  }
  await act(async () => {
    for (const [input, value] of [[name, "My account: Connect"], [key, "fixture-api-key-42"]] as const) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  for (const [locale, label, action] of [
    ["ru", "Название подключения", "Подключить"], ["en", "Connection name", "Connect"],
  ]) {
    await act(async () => { await i18n.changeLanguage(locale); });
    expect(host.textContent).toContain(label);
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === action)).toBe(true);
    expect(name.value).toBe("My account: Connect");
    expect(key.value).toBe("fixture-api-key-42");
    expect(createConnection).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  }
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Connect")!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(createConnection).toHaveBeenCalledExactlyOnceWith("company-1", {
    provider: "openrouter", method: "api_key", name: "My account: Connect", ownership: "personal",
    agentIds: ["agent-42"], allAgents: false, connectionId: undefined, apiKey: "fixture-api-key-42",
  });
  expect(complete).toHaveBeenCalledExactlyOnceWith({ connectionId: "created-id", grantId: "created-grant", method: "api_key" });
  expect(key.value).toBe("");
});
