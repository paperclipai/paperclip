// @vitest-environment jsdom
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useLocalAiLogin } from "./useLocalAiLogin";

const api = vi.hoisted(() => ({ startLocalLogin: vi.fn(), cancelLocalLogin: vi.fn(), connectLocal: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));

it("resumes once under StrictMode, preserves renaming, and cancels before retry or unmount", async () => {
  api.startLocalLogin.mockImplementation(async () => ({ sessionId: `attempt-${api.startLocalLogin.mock.calls.length}`, command: "isolated codex login", expiresAt: "2099-01-01T00:00:00Z" }));
  api.cancelLocalLogin.mockResolvedValue({});
  api.connectLocal.mockResolvedValue({ connectionId: "connection", grantId: "grant" });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  function Harness({ name }: { name: string }) {
    const login = useLocalAiLogin("company", { provider: "openai", method: "subscription", name, ownership: "personal", agentIds: [], allAgents: true }, true);
    return <><span>{login.command}</span><button onClick={login.retry}>Retry</button><button onClick={() => void login.connect()}>Connect</button></>;
  }
  try {
    flushSync(() => root.render(<StrictMode><Harness name="First name" /></StrictMode>));
    await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
    expect(api.startLocalLogin).toHaveBeenCalledTimes(1);
    expect(api.cancelLocalLogin).not.toHaveBeenCalled();
    flushSync(() => root.render(<StrictMode><Harness name="Renamed" /></StrictMode>));
    expect(api.startLocalLogin).toHaveBeenCalledTimes(1);
    flushSync(() => host.querySelectorAll("button")[1].click());
    await vi.waitFor(() => expect(api.connectLocal).toHaveBeenCalledWith("company", expect.objectContaining({ name: "Renamed", localSessionId: "attempt-1" })));
    flushSync(() => host.querySelector("button")!.click());
    await vi.waitFor(() => expect(api.startLocalLogin).toHaveBeenCalledTimes(2));
    expect(api.cancelLocalLogin).toHaveBeenCalledWith("company", "attempt-1");
    expect(api.cancelLocalLogin.mock.invocationCallOrder[0]).toBeLessThan(api.startLocalLogin.mock.invocationCallOrder[1]);
  } finally {
    flushSync(() => root.unmount());
    await vi.waitFor(() => expect(api.cancelLocalLogin).toHaveBeenCalledWith("company", "attempt-2"));
    host.remove();
  }
});
