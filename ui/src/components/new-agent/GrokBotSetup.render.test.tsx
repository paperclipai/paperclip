// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { Dialog, DialogContent } from "../ui/dialog";
import { GrokBotSetup } from "./GrokBotSetup";
import { GrokBotSetupContent } from "./GrokBotSetupContent";
import { copyTextToClipboard } from "@/lib/clipboard";
import { GrokBotConnection } from "../GrokBotConnection";

const api = vi.hoisted(() => ({ resume: vi.fn(), connection: vi.fn(), create: vi.fn(), pair: vi.fn(), configure: vi.fn(), verify: vi.fn(), retry: vi.fn() }));
vi.mock("@/api/grokBot", () => ({ grokBotApi: api }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;
afterEach(() => { flushSync(() => root?.unmount()); host?.remove(); cache?.clear(); vi.resetAllMocks(); });

it("restores the same saved agent when a failed initial resume succeeds on retry", async () => {
  const companyId = "company-fixture", agentId = "agent-saved-night-shift";
  const binding = { id: "binding-fixture", providerKind: "grok_bot", status: "connected", connected: true,
    subscriptionVerified: false, wakeVerified: false, routine: null, hasPendingChallenge: false, pairingExpiresAt: null, challengeExpiresAt: null };
  api.resume.mockRejectedValueOnce(new Error("Saved setup could not be loaded")).mockResolvedValue({
    agent: { id: agentId, name: "Saved Night Shift", botName: "Night Shift", role: "researcher", reportsTo: null, status: "idle" }, approvalId: null, binding,
  });
  api.connection.mockResolvedValue({ enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle",
    agentLifecycleState: "verifying", canConfigureConnection: true, recoveryNeeded: false, binding });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  flushSync(() => root.render(<QueryClientProvider client={cache}><Dialog open><DialogContent><GrokBotSetup companyId={companyId} companyName="Acme" onBack={() => {}} onClose={() => {}} /></DialogContent></Dialog></QueryClientProvider>));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Saved setup could not be loaded"));
  const retry = [...document.querySelectorAll("button")].find(button => button.textContent === "Try again");
  expect(retry).toBeTruthy();
  flushSync(() => retry!.click());
  await vi.waitFor(() => expect([...document.querySelectorAll("label")].some(label => label.textContent === "Webhook key")).toBe(true));
  await vi.waitFor(() => expect(api.connection).toHaveBeenCalledWith(companyId, agentId, expect.any(AbortSignal)));
  expect(api.create).not.toHaveBeenCalled();
  expect(api.pair).not.toHaveBeenCalled();
});

it.each(["rejected", "unknown"])("offers an explicit retry only for a %s delivery", async status => {
  api.connection.mockResolvedValue({ enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", recoveryNeeded: status === "unknown",
    binding: { id: "binding-fixture", connected: true, routine: { configured: true, verified: true, botName: "Night Shift", revision: 1,
      lastExchange: { id: "correlation-fixture", kind: "mailbox_updated", status, expiresAt: new Date(Date.now() + 60_000).toISOString() } } } });
  api.retry.mockResolvedValue({});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  flushSync(() => root.render(<QueryClientProvider client={cache}><GrokBotConnection companyId="company-fixture" agentId="agent-fixture" /></QueryClientProvider>));
  await vi.waitFor(() => expect(host.textContent).toContain("Night Shift"));
  const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry rejected delivery");
  expect(Boolean(retry)).toBe(status === "rejected");
  if (retry) {
    flushSync(() => retry.click());
    await vi.waitFor(() => expect(api.retry).toHaveBeenCalledExactlyOnceWith("company-fixture", "agent-fixture", "correlation-fixture"));
  } else expect(api.retry).not.toHaveBeenCalled();
});


it("copies the masked pairing code and offers a retry after a clipboard failure", async () => {
  const pairingCode = "test_code_for_agent_pairing_12345";
  vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error("Clipboard unavailable")).mockResolvedValueOnce();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  flushSync(() => root.render(<Dialog open><DialogContent><GrokBotSetupContent step={1} companyName="Acme" created
    details={{ name: "Night Shift", botName: "Night Shift", role: "researcher", reportsTo: null }} managers={[]}
    pairing={{ bindingId: "binding-fixture", pairingCode, expiresAt: new Date(Date.now() + 60_000).toISOString() }}
    webhookUrl="" webhookKey="" onDetails={() => {}} onCredentials={() => {}} onBack={() => {}}
    onExit={() => {}} onNext={() => {}} onRetry={() => {}} /></DialogContent></Dialog>));
  const label = [...document.querySelectorAll("label")].find(element => element.textContent === "One-use pairing code")!;
  const input = document.getElementById(label.htmlFor) as HTMLInputElement;
  expect(input.type).toBe("password");
  expect(input.readOnly).toBe(true);
  expect(input.value).toBe(pairingCode);
  expect(document.body.textContent).not.toContain(pairingCode);
  const copy = document.querySelector<HTMLButtonElement>('button[aria-label="Copy pairing code"]')!;
  flushSync(() => copy.click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("Copy failed"));
  flushSync(() => copy.click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("Copied!"));
  expect(copyTextToClipboard).toHaveBeenNthCalledWith(1, pairingCode);
  expect(copyTextToClipboard).toHaveBeenNthCalledWith(2, pairingCode);
  expect(document.body.textContent).not.toContain(pairingCode);
});

it("copies a masked reconnect code without adding it to Bot instructions and retries clipboard failure", async () => {
  const pairingCode = "synthetic_reconnect_code_12345";
  api.connection.mockResolvedValue({ enabled: true, canConfigureConnection: true,
    resourceUrl: "https://paperclip.example/mcp/runner", binding: null });
  api.pair.mockResolvedValue({ bindingId: "binding-fixture", pairingCode,
    expiresAt: new Date(Date.now() + 60_000).toISOString() });
  vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error("Clipboard unavailable")).mockResolvedValue();
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  flushSync(() => root.render(<QueryClientProvider client={cache}><GrokBotConnection companyId="company-fixture" agentId="agent-fixture" /></QueryClientProvider>));
  const reconnect = await vi.waitFor(() => {
    const button = [...host.querySelectorAll("button")].find(element => element.textContent === "Reconnect agent access")!;
    expect(button.disabled).toBe(false);
    return button;
  });
  flushSync(() => reconnect.click());
  const copy = await vi.waitFor(() => {
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Copy pairing code"]');
    expect(button).toBeTruthy();
    return button!;
  });
  const label = [...host.querySelectorAll("label")].find(element => element.textContent === "One-use pairing code")!;
  const input = document.getElementById(label.htmlFor) as HTMLInputElement;
  expect(input.type).toBe("password");
  expect(input.readOnly).toBe(true);
  expect(input.value).toBe(pairingCode);
  expect(host.textContent).not.toContain(pairingCode);
  flushSync(() => copy.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Copy failed"));
  flushSync(() => copy.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Copied!"));
  expect(copyTextToClipboard).toHaveBeenNthCalledWith(1, pairingCode);
  expect(copyTextToClipboard).toHaveBeenNthCalledWith(2, pairingCode);
  const instructions = host.querySelector<HTMLButtonElement>('button[aria-label="Copy connection instructions"]')!;
  flushSync(() => instructions.click());
  await vi.waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledTimes(3));
  expect(vi.mocked(copyTextToClipboard).mock.calls[2]![0]).toContain("https://paperclip.example/mcp/runner");
  expect(vi.mocked(copyTextToClipboard).mock.calls[2]![0]).not.toContain(pairingCode);
  expect(api.pair).toHaveBeenCalledExactlyOnceWith("company-fixture", "agent-fixture", undefined);
});
