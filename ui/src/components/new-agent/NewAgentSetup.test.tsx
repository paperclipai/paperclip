// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { NewAgentSetup } from "./NewAgentSetup";

const mocks = vi.hoisted(() => ({
  adapterType: "claude_local",
  navigate: vi.fn(),
  hire: vi.fn(),
  test: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [new URLSearchParams({ name: "Timeout test", adapterType: mocks.adapterType })],
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/hooks/useCloudInstance", () => ({ useCloudInstance: () => false }));
vi.mock("@/hooks/useAgentAppearanceDraft", () => ({
  useAgentAppearanceDraft: () => ({ appearance: undefined, clear: vi.fn() }),
}));
vi.mock("../AgentCharacter", () => ({ AgentCharacter: () => null }));
vi.mock("../AgentConfigForm", () => ({ ModelDropdown: () => null }));
vi.mock("./AgentProviderConnection", () => ({
  AgentProviderConnection: ({ onConnected }: { onConnected: (connection: { env: object }) => void }) => (
    <button onClick={() => onConnected({ env: {} })}>Use test connection</button>
  ),
}));
vi.mock("../ai-connections/AiConnectionField", () => ({
  aiProviderForAdapter: () => undefined,
  AiConnectionField: () => null,
}));
vi.mock("motion/react", () => ({
  MotionConfig: ({ children }: { children: ReactNode }) => children,
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ children }: { children: ReactNode }) => <div>{children}</div> },
}));
vi.mock("@/api/agents", () => ({
  agentsApi: { list: async () => [], adapterModels: async () => [], hire: mocks.hire },
}));
vi.mock("@/api/adapters", () => ({
  adaptersApi: { list: async () => ["claude_local", "codex_local", "gemini_local"].map(type => ({ type, loaded: true, disabled: false })) },
}));
vi.mock("@/api/environments", () => ({
  environmentsApi: {
    list: async () => [{ id: "local-1", driver: "local", status: "active", config: {}, name: "Local" }],
    capabilities: async () => ({ sandboxProviders: {} }),
  },
}));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    get: async () => ({ defaultEnvironmentId: null }),
    getExperimental: async () => ({}),
    getGeneral: async () => ({ executionMode: "local" }),
  },
}));
vi.mock("@/api/secrets", () => ({
  secretsApi: { list: async () => [], listMyUserSecrets: async () => [] },
}));
vi.mock("@/lib/test-agent-setup", () => ({ testAgentSetup: mocks.test }));

let root: Root | undefined;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.test.mockResolvedValue({ status: "pass", checks: [], testedAt: new Date(0).toISOString() });
  mocks.hire.mockImplementation(async (_companyId, payload) => ({
    agent: { id: "created-agent", companyId: "company-1", status: "idle", ...payload },
  }));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderSetup(adapterType: string) {
  mocks.adapterType = adapterType;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(
    <QueryClientProvider client={client}><TooltipProvider><NewAgentSetup /></TooltipProvider></QueryClientProvider>,
  ));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  return container;
}

async function click(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === label);
  expect(button, `Missing button: ${label}`).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}

async function setTimeoutInput(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it.each(["claude_local", "codex_local"])("passes the %s timeout to testing and hiring, and resets stale test results", async adapterType => {
  const container = await renderSetup(adapterType);
  await click(container, "Use test connection");
  expect(container.textContent).toContain("Timeout (sec)");
  await setTimeoutInput(container, "1800");
  await click(container, "Run test");
  expect(mocks.test).toHaveBeenCalledWith(expect.objectContaining({ adapterConfig: expect.objectContaining({ timeoutSec: 1800 }) }));
  expect(container.textContent).toContain("Connection successful");

  await setTimeoutInput(container, "900");
  expect(container.textContent).not.toContain("Connection successful");
  await click(container, "Finish setup");
  expect(mocks.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({
    adapterConfig: expect.objectContaining({ timeoutSec: 900 }),
    runtimeConfig: expect.objectContaining({ heartbeat: expect.objectContaining({ enabled: false }) }),
  }));
  expect(container.textContent).toContain("Your agent is ready");
});

it.each(["claude_local", "codex_local"])("persists an explicit zero timeout for %s", async adapterType => {
  const container = await renderSetup(adapterType);
  await click(container, "Use test connection");
  await setTimeoutInput(container, "1800");
  await setTimeoutInput(container, "0");
  await click(container, "Finish setup");
  expect(mocks.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({ adapterConfig: expect.objectContaining({ timeoutSec: 0 }) }));
});

it.each(["claude_local", "codex_local"])("rejects a negative %s timeout before testing or hiring", async adapterType => {
  const container = await renderSetup(adapterType);
  await click(container, "Use test connection");
  await setTimeoutInput(container, "1800");
  await setTimeoutInput(container, "-1");
  expect(container.textContent).toContain("Enter a number of at least 0.");
  await click(container, "Run test");
  expect(mocks.test).toHaveBeenCalledWith(expect.objectContaining({ adapterConfig: expect.objectContaining({ timeoutSec: 1800 }) }));
  await click(container, "Finish setup");
  expect(mocks.hire).not.toHaveBeenCalled();
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(input.value).toBe("1800");
  await click(container, "Finish setup");
  expect(mocks.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({ adapterConfig: expect.objectContaining({ timeoutSec: 1800 }) }));
});

it("does not offer the new timeout control for adapters outside this fix", async () => {
  const container = await renderSetup("gemini_local");
  expect(container.textContent).not.toContain("Timeout (sec)");
});
