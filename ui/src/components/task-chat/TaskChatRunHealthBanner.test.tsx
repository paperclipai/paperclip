// @vitest-environment jsdom

import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { nativeRunEventsToTranscript } from "../transcript/native-run-events";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import { TaskChatTurn } from "./TaskChatTurn";
import { partitionRunHealthItems } from "./TaskChatRunHealthBanner";
import type { TaskChatTurnItem } from "./task-chat-model";
import { coalesceSettledTurns, transcriptToTaskChatItems } from "./transcript-adapter";

const RUN_ID = "10000000-0000-4000-8000-000000000001";

function event(seq: number, eventType: string, payload: Record<string, unknown>): HeartbeatRunEvent {
  return {
    id: seq,
    companyId: "10000000-0000-4000-8000-000000000002",
    runId: RUN_ID,
    agentId: "10000000-0000-4000-8000-000000000003",
    seq,
    eventType,
    stream: "system",
    level: "info",
    color: null,
    message: null,
    payload: {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        sourceEventId: `event-${seq}`,
        sourceSeq: seq,
        sourceInstanceId: "runner-1",
        sourceKind: "runner",
        runId: RUN_ID,
        normalizedSessionId: "session-1",
        eventType,
        schemaVersion: 1,
        priority: 1,
        emittedAt: `2026-11-05T18:00:${String(seq).padStart(2, "0")}.000Z`,
        payload,
      },
    },
    createdAt: new Date(`2026-11-05T18:00:${String(seq).padStart(2, "0")}.000Z`),
  } as HeartbeatRunEvent;
}

/** The runner's mapping of a failed Codex mcpServer/startupStatus/updated. */
function mcpFailure(seq: number, server: string, reason: string) {
  return event(seq, "provider.notice.recorded", {
    schema: "paperclip.provider.notice.v1",
    noticeId: `mcp-startup:${server}`,
    severity: "warning",
    category: "mcp_server_startup_failed",
    scope: "session",
    recoverable: true,
    userActionable: true,
    summary: `${server} MCP server failed to start: ${reason}`,
    details: [{ name: "server", value: server }, { name: "reason", value: reason }],
  });
}

function itemsFrom(events: HeartbeatRunEvent[]) {
  return transcriptToTaskChatItems(nativeRunEventsToTranscript(events), { runId: RUN_ID, running: true });
}

describe("run health banner", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (events: HeartbeatRunEvent[]) =>
    act(() =>
      root.render(
        <MemoryRouter>
          <ThemeProvider>
            <TaskChatRunnerTurn runId={RUN_ID} agentName="Runner" items={itemsFrom(events)} status="running" startedAtMs={Date.now() - 2_000} />
          </ThemeProvider>
        </MemoryRouter>,
      ),
    );

  it("lifts a failed MCP start out of the timeline into one banner under the header", () => {
    render([
      mcpFailure(1, "paperclip", "program not found: paperclip-mcp"),
      event(2, "provider.notice.recorded", {
        schema: "paperclip.provider.notice.v1", noticeId: "other", severity: "warning",
        category: "auth", scope: "session", recoverable: true, userActionable: true, summary: "Sign in again",
      }),
    ]);
    const banners = container.querySelectorAll('[data-testid="task-chat-run-health-banner"]');
    expect(banners).toHaveLength(1);
    expect(banners[0].textContent).toBe("paperclip MCP server failed to start: program not found: paperclip-mcp");
    const inline = container.querySelectorAll('[data-activity-family="provider_notice"]');
    expect([...inline].map((row) => row.textContent)).toEqual([expect.stringContaining("Sign in again")]);
    const header = container.querySelector('[data-testid="task-chat-runner-identity-row"]');
    expect(header?.nextElementSibling).toBe(banners[0]);
  });

  it("names every failed server once and keeps the latest reason", () => {
    const { failures, rest } = partitionRunHealthItems(itemsFrom([
      mcpFailure(1, "github", "request timed out"),
      mcpFailure(2, "linear", "needs re-authentication"),
      mcpFailure(3, "github", "program not found: github-mcp-server"),
    ]));
    expect(rest).toEqual([]);
    expect(failures.map(({ serverName, reason }) => ({ serverName, reason }))).toEqual([
      { serverName: "github", reason: "program not found: github-mcp-server" },
      { serverName: "linear", reason: "needs re-authentication" },
    ]);
  });

  it("shows no banner and keeps the item array when every server started", () => {
    const items = itemsFrom([event(1, "item.completed", { kind: "agentMessage", channel: "final", text: "Done." })]);
    expect(partitionRunHealthItems(items).rest).toBe(items);
    render([event(1, "item.completed", { kind: "agentMessage", channel: "final", text: "Done." })]);
    expect(container.querySelector('[data-testid="task-chat-run-health-banner"]')).toBeNull();
  });

  const settledTurn = (id: string, failures: TaskChatTurnItem["mcpStartupFailures"]): TaskChatTurnItem => ({
    id, kind: "turn", settled: true, historical: true, standaloneHeader: true, agentName: "Runner",
    items: [], mcpStartupFailures: failures, summary: { toolCount: 0, added: 0, removed: 0 },
  });

  it("keeps the banner on a settled historical turn, above its activity", () => {
    act(() => root.render(
      <MemoryRouter><ThemeProvider>
        <TaskChatTurn item={settledTurn("run-1:turn", [{ id: "f", serverName: "github", reason: "No such file or directory (os error 2)" }])} renderChild={() => null} />
      </ThemeProvider></MemoryRouter>,
    ));
    expect(container.querySelector('[data-testid="task-chat-run-health-banner"]')?.textContent)
      .toBe("github MCP server failed to start: No such file or directory (os error 2)");
  });

  it("merges failures when one agent's settled turns coalesce", () => {
    const meta = { agentKey: "agent-1", agentName: "Runner", parts: [] };
    const [merged] = coalesceSettledTurns([
      settledTurn("a", [{ id: "1", serverName: "github", reason: "timed out" }]),
      settledTurn("b", [{ id: "2", serverName: "github", reason: "program not found" }, { id: "3", serverName: "linear", reason: null }]),
    ], new Map([["a", meta], ["b", meta]]));
    expect(merged.kind === "turn" && merged.mcpStartupFailures?.map(({ serverName, reason }) => [serverName, reason]))
      .toEqual([["github", "program not found"], ["linear", null]]);
  });
});
