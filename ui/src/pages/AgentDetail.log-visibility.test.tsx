// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { LogViewer } from "./AgentDetail";
import { LogViewer as ProductionLogViewer } from "./AgentDetail.production";

const { log, empty } = vi.hoisted(() => ({ log: vi.fn(), empty: [] }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { log } }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: empty }),
}));
vi.mock("../adapters", () => ({
  getUIAdapter: () => null,
  onAdapterChange: () => () => {},
  buildTranscript: (lines: unknown[]) => lines,
}));
vi.mock("../components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({ entries }: { entries: Array<{ chunk: string }> }) => <div>{entries.map(line => line.chunk).join(" ")}</div>,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); log.mockReset(); });

it.each([LogViewer, ProductionLogViewer])("retains legacy history and reads only the next offset on visibility recovery (%#)", async (Viewer) => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const row = (seq: number, chunk: string) => JSON.stringify({ seq, ts: `2026-09-10T12:00:0${seq}Z`, stream: "stdout", chunk }) + "\n";
  const first = row(1, "retained history");
  const second = row(2, "new output");
  log.mockResolvedValueOnce({ content: first, nextOffset: first.length });
  const run = { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "succeeded", logRef: "log" } as HeartbeatRun;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Viewer run={run} adapterType="codex_local" />));
    expect(container.textContent).toContain("retained history");
    await act(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("retained history");
    let complete!: (value: { content: string; nextOffset: number }) => void;
    log.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.textContent).toContain("retained history");
    expect(log).toHaveBeenLastCalledWith("run-1", first.length, expect.any(Number));
    await act(async () => complete({ content: second, nextOffset: first.length + second.length }));
    expect(container.textContent).toContain("retained history new output");
    log.mockResolvedValueOnce({ content: first, nextOffset: first.length });
    await act(async () => root.render(<Viewer run={{ ...run, id: "run-2" }} adapterType="codex_local" />));
    expect(log).toHaveBeenLastCalledWith("run-2", 0, expect.any(Number));
    expect(container.textContent).not.toContain("new output");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
