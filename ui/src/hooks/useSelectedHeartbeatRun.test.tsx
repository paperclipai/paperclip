// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSelectedHeartbeatRun } from "./useSelectedHeartbeatRun";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { get } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { get.mockReset(); });

const row = (id: string, extra = {}) => ({ id, companyId: "company-1", agentId: "agent-1", ...extra }) as HeartbeatRun;
function Probe({ runs, id }: { runs: HeartbeatRun[]; id: string | null }) {
  const selected = useSelectedHeartbeatRun(runs, id, "company-1", "agent-1");
  return <div>
    <output>{selected.run?.id ?? (selected.error ? "failed" : selected.loading ? "loading" : "unavailable")}</output>
    <button onClick={() => { void selected.retry(); }}>Retry</button>
  </div>;
}

async function harness(runs: HeartbeatRun[], id: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  const render = async (nextId = id) => act(async () => root.render(<QueryClientProvider client={client}><Probe runs={runs} id={nextId} /></QueryClientProvider>));
  await render();
  return { element, render, dispose: async () => { await act(async () => root.unmount()); client.clear(); element.remove(); } };
}

describe("bounded history selection", () => {
  it("opens a listed run without an additional lookup", async () => {
    const h = await harness([row("recent")], "recent");
    try { expect(h.element.querySelector("output")?.textContent).toBe("recent"); expect(get).not.toHaveBeenCalled(); }
    finally { await h.dispose(); }
  });
  it.each([{ runs: [] }, { runs: [row("recent")] }])("opens an older link outside the history page (%#)", async ({ runs }) => {
    get.mockResolvedValue(row("older"));
    const h = await harness(runs, "older");
    try {
      await vi.waitFor(async () => { await act(async () => {}); expect(h.element.querySelector("output")?.textContent).toBe("older"); });
      expect(get).toHaveBeenCalledWith("older");
    } finally { await h.dispose(); }
  });
  it.each([{ companyId: "other" }, { agentId: "other" }, { id: "other" }])("rejects a mismatched fetched run (%j)", async extra => {
    get.mockResolvedValue(row("older", extra));
    const h = await harness([], "older");
    try { await vi.waitFor(async () => { await act(async () => {}); expect(h.element.querySelector("output")?.textContent).toBe("unavailable"); }); }
    finally { await h.dispose(); }
  });
  it("keeps late responses attached to their own navigation and retries errors", async () => {
    let finish!: (run: HeartbeatRun) => void;
    get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    get.mockRejectedValueOnce(new Error("temporary failure"));
    const h = await harness([], "older");
    try {
      await h.render("newer");
      await vi.waitFor(async () => { await act(async () => {}); expect(h.element.querySelector("output")?.textContent).toBe("failed"); });
      await act(async () => finish(row("older")));
      expect(h.element.querySelector("output")?.textContent).toBe("failed");
      get.mockResolvedValueOnce(row("newer"));
      await act(async () => h.element.querySelector("button")!.click());
      await vi.waitFor(async () => { await act(async () => {}); expect(h.element.querySelector("output")?.textContent).toBe("newer"); });
    } finally { await h.dispose(); }
  });
});
