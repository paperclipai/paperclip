// @vitest-environment jsdom
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLocalAiLogin } from "./useLocalAiLogin";
import { LocalProviderLoginInstructions } from "../AdapterLoginChrome";

const api = vi.hoisted(() => ({ startLocalLogin: vi.fn(), checkLocalLogin: vi.fn(), cancelLocalLogin: vi.fn(), connectLocal: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  api.startLocalLogin.mockImplementation(async () => ({ sessionId: "attempt-1", command: "isolated codex login", expiresAt: "2099-01-01T00:00:00Z" }));
  api.checkLocalLogin.mockResolvedValue({ status: "sign_in_required" });
  api.cancelLocalLogin.mockResolvedValue({});
  api.connectLocal.mockResolvedValue({ connectionId: "connection", grantId: "grant" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });
function Harness({ name = "Account", provider = "openai", enabled = true }: { name?: string; provider?: "anthropic" | "openai"; enabled?: boolean }) {
  const login = useLocalAiLogin("company", { provider, method: "subscription", name, ownership: "personal", agentIds: [], allAgents: true }, enabled, { allowHostClaude: true });
  return <><LocalProviderLoginInstructions adapterType={provider === "anthropic" ? "claude_local" : "codex_local"} login={login} /><button onClick={() => void login.connect()}>Connect</button></>;
}
it("checks once under StrictMode, preserves renaming and navigation, and cancels only on explicit retry", async () => {
  flushSync(() => root.render(<StrictMode><Harness name="First name" /></StrictMode>));
  await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
  expect(api.startLocalLogin).toHaveBeenCalledTimes(1);
  expect(api.checkLocalLogin).toHaveBeenCalledTimes(1);
  expect(api.cancelLocalLogin).not.toHaveBeenCalled();
  flushSync(() => root.render(<StrictMode><Harness name="Renamed" /></StrictMode>));
  expect(api.startLocalLogin).toHaveBeenCalledTimes(1);
  flushSync(() => root.render(<StrictMode><Harness name="Renamed" enabled={false} /></StrictMode>));
  flushSync(() => root.render(<StrictMode><Harness name="Renamed" /></StrictMode>));
  await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
  expect(api.cancelLocalLogin).not.toHaveBeenCalled();
  flushSync(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Connect')!.click());
  await vi.waitFor(() => expect(api.connectLocal).toHaveBeenCalledWith("company", expect.objectContaining({ name: "Renamed", localSessionId: "attempt-1" })));
  flushSync(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Start sign-in again')!.click());
  await vi.waitFor(() => expect(api.startLocalLogin).toHaveBeenCalledTimes(2));
  expect(api.cancelLocalLogin).toHaveBeenCalledTimes(1);
  expect(api.cancelLocalLogin.mock.invocationCallOrder[0]).toBeLessThan(api.startLocalLogin.mock.invocationCallOrder[1]);
});
it.each(["anthropic", "openai"] as const)("detects an already-signed-in %s account before showing instructions, and does not save it until Connect", async provider => {
  api.checkLocalLogin.mockResolvedValue({ status: "ready" });
  flushSync(() => root.render(<Harness provider={provider} />));
  expect(host.textContent).toContain("Checking local");
  await vi.waitFor(() => expect(host.textContent).toContain("is signed in"));
  expect(host.textContent).not.toContain("Run this in a terminal");
  expect(api.connectLocal).not.toHaveBeenCalled();
  if (provider === "anthropic") expect(api.startLocalLogin).not.toHaveBeenCalled();
});
it("detects terminal completion on focus without needing a Connect attempt", async () => {
  flushSync(() => root.render(<Harness />));
  await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
  api.checkLocalLogin.mockResolvedValue({ status: "ready" });
  window.dispatchEvent(new Event('focus'));
  await vi.waitFor(() => expect(host.textContent).toContain("is signed in"));
  expect(host.textContent).not.toContain("isolated codex login");
  expect(api.connectLocal).not.toHaveBeenCalled();
});
it("keeps a copied command's attempt alive after leaving the page", async () => {
  flushSync(() => root.render(<Harness />));
  await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
  flushSync(() => root.render(<div>Another page</div>));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(api.cancelLocalLogin).not.toHaveBeenCalled();
  const checks = api.checkLocalLogin.mock.calls.length;
  window.dispatchEvent(new Event('focus'));
  expect(api.checkLocalLogin).toHaveBeenCalledTimes(checks);
});

it("explicit retry can replace an attempt opened in another authentication host", async () => {
  api.startLocalLogin.mockRejectedValueOnce(new Error("Another sign-in is still open."));
  flushSync(() => root.render(<Harness />));
  await vi.waitFor(() => expect(host.textContent).toContain("Another sign-in"));
  flushSync(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Start sign-in again')!.click());
  await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
  expect(api.startLocalLogin).toHaveBeenLastCalledWith("company", expect.objectContaining({ restart: true }));
});
