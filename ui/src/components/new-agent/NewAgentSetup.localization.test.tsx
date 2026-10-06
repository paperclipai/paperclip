// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { NewAgentSetup } from "./NewAgentSetup";
import type { ProviderConnection } from "./AgentProviderConnection";

const mocks = vi.hoisted(() => ({ test: vi.fn(), hire: vi.fn(), picker: vi.fn(), navigate: vi.fn() }));
const selectedConnection: ProviderConnection = {
  env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "chosen-secret", version: "latest" } },
  storedSessionId: "saved-session",
};
vi.mock("@/lib/router", () => ({
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [new URLSearchParams({ name: "Agent draft: Connect", adapterType: "codex_local" })],
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/hooks/useCloudInstance", () => ({ useCloudInstance: () => false }));
vi.mock("@/api/adapters", () => ({ adaptersApi: { list: async () => [{ type: "codex_local", loaded: true }] } }));
vi.mock("@/api/agents", () => ({ agentsApi: {
  list: async () => [],
  adapterModels: async () => [],
  hire: mocks.hire,
} }));
vi.mock("@/api/environments", () => ({ environmentsApi: {
  list: async () => [{ id: "local-1", name: "Customer environment", driver: "local", status: "active", config: {}, metadata: { defaultForInstance: true } }],
  capabilities: async () => ({ sandboxProviders: {} }),
} }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: {
  get: async () => ({}), getExperimental: async () => ({}), getGeneral: async () => ({}),
} }));
vi.mock("@/api/secrets", () => ({ secretsApi: { list: async () => [], listMyUserSecrets: async () => [] } }));
vi.mock("@/lib/test-agent-setup", () => ({ testAgentSetup: mocks.test }));
vi.mock("@/adapters", () => ({ getUIAdapter: () => ({ buildAdapterConfig: (values: { envBindings: object; model: string }) => ({ env: values.envBindings, model: values.model }) }) }));
vi.mock("../ai-connections/AiConnectionField", () => ({
  aiProviderForAdapter: () => "openai",
  AiConnectionField: (props: unknown) => { mocks.picker(props); return <div data-testid="picker" />; },
}));
vi.mock("./AgentProviderConnection", () => ({
  AgentProviderConnection: ({ onConnected }: { onConnected: (connection: ProviderConnection) => void }) =>
    <button onClick={() => onConnected(selectedConnection)}>Use retained connection</button>,
}));
vi.mock("../AgentConfigForm", () => ({
  ModelDropdown: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    <input aria-label="Model fixture" value={value} onChange={(event) => onChange(event.target.value)} />,
}));
vi.mock("../RuntimeTestCard", () => ({ RuntimeTestCard: ({ onTest, disabled }: { onTest: () => void; disabled: boolean }) =>
  <button type="button" disabled={disabled} onClick={onTest}>Verify retained connection</button>,
}));
vi.mock("../onboarding/PillGuy", () => ({ PillGuy: () => null }));
vi.mock("./AgentBasicsDialog", () => ({ AgentBasicsDialog: () => null, AdapterMark: () => null }));
vi.mock("motion/react", () => ({
  MotionConfig: ({ children }: { children: ReactNode }) => children,
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ children }: { children: ReactNode }) => <div>{children}</div> },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label)!;

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  mocks.test.mockResolvedValue({ status: "pass", testedAt: "2026-09-16T00:00:00Z", checks: [{ code: "codex_hello_probe_passed", level: "info", message: "Provider diagnostic" }] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={cache}><NewAgentSetup /></QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  host.remove();
  await i18n.changeLanguage("en");
});

it("retains the Connect selection and model draft through en/ru/en, then tests those same credentials", async () => {
  await act(async () => button("Use retained connection").click());
  const model = host.querySelector('input[aria-label="Model fixture"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(model, "model-id/Custom-42");
    model.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (const [locale, copy, action] of [
    ["ru", "Настройте агента", "Подключение"],
    ["en", "Configure your agent", "Connection"],
  ]) {
    await act(async () => { await i18n.changeLanguage(locale); });
    expect(host.textContent).toContain(copy);
    expect(button(action)).toBeDefined();
    expect(host.querySelector("h1")?.textContent).toBe("Agent draft: Connect");
    expect(model.value).toBe("model-id/Custom-42");
    expect(mocks.picker).not.toHaveBeenCalled();
    expect(mocks.test).not.toHaveBeenCalled();
    expect(mocks.hire).not.toHaveBeenCalled();
  }
  await act(async () => button("Verify retained connection").click());
  expect(mocks.test).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    companyId: "company-1", adapterType: "codex_local", environmentId: "local-1",
    adapterConfig: expect.objectContaining({ model: "model-id/Custom-42", env: selectedConnection.env }),
  }));
  await act(async () => button("Connection").click());
  expect(button("Use retained connection")).toBeDefined();
  expect(mocks.hire).not.toHaveBeenCalled();
});
