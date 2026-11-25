// @vitest-environment jsdom

import { act } from "react";
import swarmRun from "../transcript/fixtures/antigravity-swarm-run.json";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { paperclipRunnerUIAdapter } from "@/adapters/paperclip-runner";
import type { TranscriptEntry } from "@/adapters";
import { nativeRunEventsToTranscript } from "@/components/transcript/native-run-events";
import { TaskChatRunnerActivityGroup } from "./TaskChatRunnerActivityGroup";
import type { TaskChatActivityPhaseItem } from "./task-chat-model";
import { markRetriedTools, paperclipRunnerActivityItems, transcriptToTaskChatItems } from "./transcript-adapter";

/** One live Antigravity /swarm run's tool, bridge-call and final-message events (see the fixture's provenance). */
const fixture = swarmRun as unknown as { runId: string; events: HeartbeatRunEvent[] };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** The activity rows a person reads, as "<label> <subject>". */
function renderedRows(entries: TranscriptEntry[]): string[] {
  const items = paperclipRunnerActivityItems(transcriptToTaskChatItems(entries, { runId: fixture.runId, running: false }));
  const phase: TaskChatActivityPhaseItem = {
    id: "phase-1",
    kind: "activity_phase",
    items: items as TaskChatActivityPhaseItem["items"],
    summary: "",
    active: false,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<TaskChatRunnerActivityGroup item={phase} defaultExpanded />));
  const rows = [...container.querySelectorAll("[data-activity-row]")].map((row) => {
    const text = row.querySelector("[data-activity-icon] + span");
    return [...(text?.children ?? [])].map((part) => part.textContent?.trim()).filter(Boolean).join(" ");
  });
  act(() => root!.unmount());
  container.remove();
  root = null;
  return rows;
}

/** The same events as the run log streams them while the run is live. */
function liveEntries(): TranscriptEntry[] {
  const parser = paperclipRunnerUIAdapter.createStdoutParser!();
  return fixture.events.flatMap((event) => parser.parseLine(
    JSON.stringify({ type: "paperclip.prp.event", event: (event.payload as { prpEvent: unknown }).prpEvent }),
    event.createdAt as unknown as string,
  ));
}

describe("an Antigravity swarm run's task thread", () => {
  const settled = () => renderedRows(nativeRunEventsToTranscript(fixture.events));

  it("reads in plain language after the run", () => {
    expect(settled()).toEqual([
      "Swarm started in the task folder with Gemini 3.8 Flash (Low) on Google's default channel (Antigravity CLI 1.5.15). Helper changes inside the task folder are approved automatically; anything else is blocked.",
      "This swarm runs on the Google account of this agent's Google connection.",
      "Goal: Create and verify u1.txt and u2.txt",
      "Started helper writer1: Create a file named u1.txt in the current workspace directory containing exactly \"one\"",
      "Started helper writer2: Create a file named u2.txt in the current workspace directory containing exactly \"two\"",
      "Started helper verifier: You are the verifier",
      "Started a helper that watches for stalls",
      "Checked on the helpers",
      "Checked on the helpers",
      // The CLI's first reads used a relative path and were refused; the same reads then succeeded.
      "Read · retried u1.txt",
      "Read · retried u2.txt",
      "Read u1.txt",
      "Read u2.txt",
      "Coordinator: All files u1.txt and u2.txt created and verified successfully",
      "$ shasum -a 256 u1.txt u2.txt; wc -c u1.txt u2.txt",
      // One row per file, with the file's name, never the bridge's arguments or a digest.
      "Attached u1.txt",
      "Attached u2.txt",
      "Files changed in the task folder: u1.txt, u2.txt",
      "Token usage is the coordinator's total and includes the helpers; Google does not report it per helper",
    ]);
  });

  it("hides the finish tool, including the attempt Paperclip refused", () => {
    expect(settled().join("\n")).not.toMatch(/finish|completion|· failed/i);
  });

  it("reads the same while the run is live", () => {
    expect(renderedRows(liveEntries())).toEqual(settled());
  });

  it("shows a paired bridge call's arguments live, as the settled row does", () => {
    const parser = paperclipRunnerUIAdapter.createStdoutParser!();
    const line = (event: Record<string, unknown>) => parser.parseLine(JSON.stringify({ type: "paperclip.prp.event", event }), "2026-11-25T05:51:00Z");
    line({ eventType: "tool.execution.started", itemId: "item-1", payload: { schema: "paperclip.tool.execution.v1", executionId: "call_1",
      name: "search_tasks", namespace: "paperclip", transport: "mcp", operation: "search", status: "running" } });
    const paired = line({ eventType: "item.started", itemId: "7", payload: { kind: "dynamicToolCall",
      item: { id: "7", type: "tool_use", name: "search_tasks", input: { query: "open bugs", limit: 5 } } } });
    expect(paired).toEqual([expect.objectContaining({ kind: "provider_activity", payload: expect.objectContaining({ executionId: "call_1", subject: "open bugs" }) })]);
  });

  it("never calls a failure retried when the shortened subjects only look alike", () => {
    const tool = (id: string, status: "failed" | "completed", target: string) =>
      ({ id, kind: "tool", name: "run_command", status, target }) as Parameters<typeof markRetriedTools>[0][number];
    const clipped = `${"x".repeat(399)}…`;
    expect(markRetriedTools([tool("a", "failed", clipped), tool("b", "completed", clipped)])[0]).not.toHaveProperty("retried");
    expect(markRetriedTools([tool("a", "failed", "npm test"), tool("b", "completed", "npm test")])[0]).toHaveProperty("retried", true);
  });

  it("never shows raw tool names, internal paths or hashes", () => {
    const text = [...settled(), ...renderedRows(liveEntries())].join("\n");
    expect(text).not.toMatch(/mcp_|paperclip_|register_deliverable|view_file|run_command|swarm_update|\.\.\/|antigravity-home|sha256|[0-9a-f]{40}/);
  });
});
