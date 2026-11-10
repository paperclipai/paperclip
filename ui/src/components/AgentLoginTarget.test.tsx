// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentLoginTarget } from "./AgentLoginTarget";
const mocks = vi.hoisted(() => ({ list: vi.fn(), settings: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.list } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { get: mocks.settings } }));
let root: Root, container: HTMLDivElement, client: QueryClient;
async function settle() { for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); } }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ defaultEnvironmentId: "environment" });
  mocks.list.mockResolvedValue([
    { id: "eligible", name: "Setup computer", adapterType: "paperclip_runner", lifecycleState: "verifying", defaultEnvironmentId: null },
    { id: "foreign-env", name: "Another computer", adapterType: "paperclip_runner", lifecycleState: "ready", defaultEnvironmentId: "another" },
    { id: "pending", name: "Pending computer", adapterType: "paperclip_runner", lifecycleState: "pending", defaultEnvironmentId: "environment" },
  ]);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });
function mount(agentId?: string) { flushSync(() => root.render(<QueryClientProvider client={client}><AgentLoginTarget companyId="company" environmentId="environment" agentId={agentId}>{target => <div data-target={target}>Login ready</div>}</AgentLoginTarget></QueryClientProvider>)); }
it("uses a contextual saved agent without listing unrelated computers", async () => { mount("context-agent"); await settle(); expect(container.querySelector('[data-target="context-agent"]')).not.toBeNull(); expect(mocks.list).not.toHaveBeenCalled(); });
it("waits for an explicit eligible transport target before starting login", async () => {
  mount(); await settle(); expect(container.querySelector("[data-target]")).toBeNull();
  const trigger = container.querySelector('[role="combobox"]')!;
  flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))); await settle();
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  expect(options.map(option => option.textContent)).toEqual(["Setup computer"]);
  flushSync(() => options[0].click()); await settle();
  expect(container.querySelector('[data-target="eligible"]')).not.toBeNull();
});

it("keeps selection work linear across a company-sized agent list", async () => {
  let reads = 0;
  const agents = Array.from({ length: 600 }, (_, index) => ({
    get id() { if (++reads > 50000) throw new Error("Agent selection exceeded its linear work bound"); return `computer-${index}`; },
    name: `Computer ${index}`, adapterType: "paperclip_runner", lifecycleState: "ready", defaultEnvironmentId: "environment",
  }));
  mocks.list.mockResolvedValue(agents);
  mount(); await settle();
  flushSync(() => container.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await settle();
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  expect(options).toHaveLength(600);
  flushSync(() => options[599].click()); await settle();
  expect(container.querySelector('[data-target="computer-599"]')).not.toBeNull();
  expect(reads).toBeLessThan(50000);
});
