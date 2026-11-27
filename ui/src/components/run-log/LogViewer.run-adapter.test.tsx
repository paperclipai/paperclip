// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import { LogViewer } from "./LogViewer";

const mocks = vi.hoisted(() => ({ adapter: vi.fn((type: string) => ({ type })), empty: [] }));
vi.mock("@tanstack/react-query", async original => ({ ...await original<typeof import("@tanstack/react-query")>(), useQuery: () => ({ data: mocks.empty }) }));
vi.mock("../../api/heartbeats", () => ({ heartbeatsApi: { events: async () => [], log: async () => ({ content: "" }) } }));
vi.mock("../../adapters", () => ({ getUIAdapter: mocks.adapter, onAdapterChange: () => () => {}, buildTranscript: () => [] }));
vi.mock("../transcript/RunTranscriptView", () => ({ RunTranscriptView: () => null }));

it("selects the admitted Codex parser even when the agent is configured for Claude", async () => {
  const root = createRoot(document.createElement("div"));
  const run = { id: "run", companyId: "company", agentId: "agent", status: "succeeded", logRef: null,
    runnerProfileJson: { adapterDispatch: { adapterType: "codex_local", configuredAdapterType: "claude_local" } } } as unknown as HeartbeatRun;
  try {
    await act(async () => root.render(<LogViewer run={run} adapterType="claude_local" />));
    expect(mocks.adapter).toHaveBeenCalledWith("codex_local");
    expect(mocks.adapter).not.toHaveBeenCalledWith("claude_local");
    mocks.adapter.mockClear();
    await act(async () => root.render(<LogViewer run={{ ...run, runnerProfileJson: null }} adapterType="claude_local" />));
    expect(mocks.adapter).toHaveBeenCalledWith("claude_local");
  } finally {
    await act(async () => root.unmount());
  }
});
