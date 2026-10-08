// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildTranscript as parseTranscript } from "../adapters/transcript";
import type { TranscriptParserSource } from "../adapters/types";
import { LogViewer } from "./AgentDetail";
import { LogViewer as ProductionLogViewer } from "./AgentDetail.production";

const { log, events, empty, getUIAdapter, buildTranscript } = vi.hoisted(() => ({
  log: vi.fn(), events: vi.fn(async () => []), empty: [], getUIAdapter: vi.fn(), buildTranscript: vi.fn(),
}));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { log, events } }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: empty }),
}));
vi.mock("../adapters", () => ({
  getUIAdapter,
  onAdapterChange: () => () => {},
  buildTranscript,
}));
vi.mock("../components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({ entries }: { entries: Array<{ chunk?: string; text?: string }> }) => <div>{entries.map(line => line.text ?? line.chunk).join(" ")}</div>,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { getUIAdapter.mockReturnValue(null); buildTranscript.mockImplementation((lines: unknown[]) => lines); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); log.mockReset(); events.mockClear(); getUIAdapter.mockReset(); buildTranscript.mockReset(); });

it.each([
  { recorded: "codex_local", current: "paperclip_runner" },
  { recorded: "paperclip_runner", current: "codex_local" },
])("parses recorded $recorded history independently of the current $current runner", async ({ recorded, current }) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const sources: Record<string, TranscriptParserSource> = {
    codex_local: { parseStdoutLine: vi.fn<TranscriptParserSource["parseStdoutLine"]>((line, ts) => [{ kind: "stdout", ts, text: `legacy parser: ${line}` }]) },
    paperclip_runner: { parseStdoutLine: vi.fn<TranscriptParserSource["parseStdoutLine"]>((line, ts) => [{ kind: "stdout", ts, text: `native parser: ${line}` }]) },
  };
  getUIAdapter.mockImplementation((type: string) => sources[type]);
  buildTranscript.mockImplementation(parseTranscript);
  const chunk = JSON.stringify({ seq: 1, ts: "2026-09-10T12:00:01Z", stream: "stdout", chunk: "retained history\n" }) + "\n";
  log.mockResolvedValueOnce({ content: chunk, nextOffset: chunk.length });
  const run = { id: "recorded-run", companyId: "company-1", agentId: "agent-1", status: "succeeded", logRef: "log", adapterType: recorded } as HeartbeatRun;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const marker = recorded === "codex_local" ? "legacy parser" : "native parser";
  const otherMarker = recorded === "codex_local" ? "native parser" : "legacy parser";
  try {
    await act(async () => root.render(<LogViewer run={run} adapterType={current} />));
    expect(getUIAdapter).toHaveBeenLastCalledWith(recorded);
    expect(buildTranscript).toHaveBeenLastCalledWith(expect.any(Array), sources[recorded], expect.any(Object));
    expect(sources[recorded].parseStdoutLine).toHaveBeenCalledWith("retained history", "2026-09-10T12:00:01Z");
    expect(sources[current].parseStdoutLine).not.toHaveBeenCalled();
    expect(container.textContent).toContain(`${marker}: retained history`);
    expect(container.textContent).not.toContain(`${otherMarker}: retained history`);
    getUIAdapter.mockClear();
    buildTranscript.mockClear();
    await act(async () => root.render(<LogViewer run={run} adapterType={recorded} />));
    expect(getUIAdapter).toHaveBeenLastCalledWith(recorded);
    expect(log).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(`${marker}: retained history`);
    expect(container.textContent).not.toContain(`${otherMarker}: retained history`);
    expect(sources[current].parseStdoutLine).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

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

it.each([LogViewer, ProductionLogViewer])("polls logs when WebSocket construction fails and recovers on retry (%#)", async (Viewer) => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("WebSocket", undefined);
  log.mockResolvedValue({ content: "", nextOffset: 0 });
  const run = { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "running", logRef: "log" } as HeartbeatRun;
  const root = createRoot(document.createElement("div"));
  const sockets: Array<{ onopen: (() => void) | null; close: () => void }> = [];
  try {
    await act(async () => root.render(<Viewer run={run} adapterType="codex_local" />));
    const initialReads = log.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(log.mock.calls.length).toBeGreaterThan(initialReads);
    expect(events).toHaveBeenCalled();
    vi.stubGlobal("WebSocket", class {
      onopen = null;
      close = vi.fn();
      constructor() { sockets.push(this); }
    });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(sockets).toHaveLength(1);
    await act(async () => sockets[0].onopen?.());
    const readsWhenConnected = log.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(log).toHaveBeenCalledTimes(readsWhenConnected);
  } finally {
    await act(async () => root.unmount());
  }
  expect(sockets[0].close).toHaveBeenCalled();
});
