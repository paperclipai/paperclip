import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalProviderEventsFromAcpxRuntimeEvent,
  createAcpxToolEventNormalizer,
  type AcpRuntimeEventShape,
} from "../../provider-events.js";
import { createAntigravityToolEventProjection } from "./antigravity-activity.js";
import { antigravitySwarmEvent, antigravitySwarmLine } from "./antigravity-swarm-presentation.js";
import { antigravityToolDetail } from "./antigravity-tool-identity.js";

const fixture = JSON.parse(readFileSync(new URL("../../../test-fixtures/antigravity-cli/swarm-thread.updates.json", import.meta.url), "utf8")) as {
  workspace: string;
  updates: Record<string, unknown>[];
};

type ToolPayload = { name: string | null; namespace: string | null; transport: string; status: string; subject?: string; target: string | null };

/** What the run record stores for each tool update, the way the runner maps it. */
function storedTools(events: Iterable<AcpRuntimeEventShape | null>): ToolPayload[] {
  const normalize = createAcpxToolEventNormalizer<AcpRuntimeEventShape>({ now: () => 0 });
  const tools: ToolPayload[] = [];
  for (const event of events) {
    if (!event) continue;
    for (const mapped of canonicalProviderEventsFromAcpxRuntimeEvent(normalize(event), "item-1", "turn-1", { workingDirectory: fixture.workspace })) {
      if (mapped.eventType.startsWith("tool.execution.")) tools.push(mapped.payload as unknown as ToolPayload);
    }
  }
  return tools;
}

const completed = (tools: ToolPayload[]) => tools.filter(tool => tool.status !== "running");

describe("Antigravity tool identity", () => {
  it("names a swarm's Paperclip tools the way every other harness does, not after the CLI's title", () => {
    const all = storedTools(fixture.updates.map(update => antigravitySwarmEvent(update, fixture.workspace) as AcpRuntimeEventShape | null));
    // Not even as live progress: the CLI's titles are display text.
    expect(JSON.stringify(all)).not.toMatch(/Run mcp_|mcp_paperclip_|File \.\.\//);
    const tools = completed(all);
    const finish = tools.filter(tool => tool.name === "paperclip_finish");
    // The refused first attempt and the accepted second one are both the canonical finish tool,
    // so the task thread hides both exactly as it does for Claude or Codex.
    expect(finish).toEqual([
      expect.objectContaining({ namespace: "paperclip", transport: "mcp", status: "failed" }),
      expect.objectContaining({ namespace: "paperclip", transport: "mcp", status: "completed" }),
    ]);
    expect(tools).toContainEqual(expect.objectContaining({ name: "register_deliverable", namespace: "paperclip", transport: "mcp" }));
    expect(tools.map(tool => tool.name)).not.toContainEqual(expect.stringMatching(/^Run |mcp_paperclip|^File /));
  });

  it("names the CLI's own tools by their native name, with the command as the subject and no internal paths", () => {
    const tools = completed(storedTools(fixture.updates.map(update => antigravitySwarmEvent(update, fixture.workspace) as AcpRuntimeEventShape | null)));
    expect(tools).toContainEqual(expect.objectContaining({ name: "run_command", subject: "shasum -a 256 u1.txt u2.txt; wc -c u1.txt u2.txt" }));
    expect(tools.filter(tool => tool.name === "view_file")).toEqual([
      expect.objectContaining({ status: "failed", target: "u1.txt" }),
      expect.objectContaining({ status: "completed", target: "u1.txt" }),
    ]);
    // The CLI loading its own built-in skill is not work on the task.
    expect(JSON.stringify(tools)).not.toMatch(/antigravity-home|SKILL\.md|\.\.\//);
  });

  it("gives swarm progress lines one neutral identity whose subject is the plain sentence", () => {
    const tools = completed(storedTools([
      ...fixture.updates.slice(2, 5).map(update => antigravitySwarmEvent({ ...update, sessionUpdate: "tool_call_update", status: "completed" }, fixture.workspace) as AcpRuntimeEventShape | null),
      antigravitySwarmLine("paperclip-swarm-files", "Files changed in the task folder: u1.txt, u2.txt", "tool_call", "completed") as AcpRuntimeEventShape,
    ]));
    expect(tools.map(tool => [tool.name, tool.subject])).toEqual([
      ["swarm_update", "Goal: Create and verify u1.txt and u2.txt"],
      ["swarm_update", "Started helper writer1: Create a file named u1.txt in the current workspace directory containing exactly \"one\""],
      ["swarm_update", "Checked on the helpers"],
      ["swarm_update", "Files changed in the task folder: u1.txt, u2.txt"],
    ]);
  });

  it("names an ordinary run's Paperclip tools from their `<server>_<tool>` title or ACP MCP metadata", () => {
    const project = createAntigravityToolEventProjection();
    const updates: AcpRuntimeEventShape[] = [
      { type: "tool_call", tag: "tool_call", toolCallId: "t1", title: "paperclip_set_task_title", kind: "other", status: "in_progress" },
      { type: "tool_call", tag: "tool_call_update", toolCallId: "t1", title: "paperclip_set_task_title", kind: "other", status: "completed", rawOutput: "Set task title" },
      { type: "tool_call", tag: "tool_call", toolCallId: "t2", title: "paperclip_paperclip_finish", kind: "other", status: "in_progress" },
      { type: "tool_call", tag: "tool_call_update", toolCallId: "t2", title: "paperclip_paperclip_finish", kind: "other", status: "failed" },
      { type: "tool_call", tag: "tool_call", toolCallId: "t3", title: "paperclip_write_document", kind: "other", status: "completed",
        _meta: { mcp: { tool: "write_document", server: "paperclip" }, is_mcp_tool_call: true } },
      { type: "tool_call", tag: "tool_call", toolCallId: "t4", title: "touch greeting.txt", kind: "execute", status: "completed", rawInput: { CommandLine: "touch greeting.txt" } },
    ];
    const all = storedTools(updates.map(update => project(update)));
    expect(JSON.stringify(all)).not.toMatch(/"progress":"paperclip_/);
    const tools = completed(all);
    expect(tools.map(tool => [tool.name, tool.namespace, tool.subject])).toEqual([
      ["set_task_title", "paperclip", undefined],
      ["paperclip_finish", "paperclip", undefined],
      ["write_document", "paperclip", undefined],
      ["run_command", null, "touch greeting.txt"],
    ]);
  });

  it("drops every update of a read of the CLI's own files, even one that no longer names the path", () => {
    const project = createAntigravityToolEventProjection();
    expect(project({ type: "tool_call", toolCallId: "s1", kind: "read", status: "in_progress",
      title: "File ../../runtime/paperclip-runner/acpx/acpx/session-1/antigravity-home/antigravity-cli/antigravity-cli/builtin/skills/a/SKILL.md" })).toBeNull();
    expect(project({ type: "tool_call", toolCallId: "s1", kind: "read", status: "completed" })).toBeNull();
    expect(project({ type: "text_delta", text: "hi" })).toEqual({ type: "text_delta", text: "hi" });
  });

  it("keeps work on a task folder that happens to be named antigravity-home, and any command or edit", () => {
    const project = createAntigravityToolEventProjection();
    const shown = [
      { type: "tool_call", toolCallId: "t1", kind: "read", status: "completed", title: "File antigravity-home/notes.md", locations: [{ path: "antigravity-home/notes.md" }] },
      { type: "tool_call", toolCallId: "t2", kind: "execute", status: "completed", title: "mkdir -p antigravity-home/config", rawInput: { CommandLine: "mkdir -p antigravity-home/config" } },
      { type: "tool_call", toolCallId: "t3", kind: "edit", status: "completed", title: "Write file",
        locations: [{ path: "/runtime/paperclip-runner/acpx/s/antigravity-home/antigravity-cli/settings.json" }] },
    ];
    for (const event of shown) expect(project(event)).not.toBeNull();
  });

  it("names a deletion and a move as what they are, never as an edit", () => {
    expect(antigravityToolDetail({ title: "Delete old.txt", kind: "delete" })).toEqual({ toolName: "delete_file" });
    expect(antigravityToolDetail({ title: "Move a.txt", kind: "move" })).toEqual({ toolName: "move_file" });
    expect(antigravityToolDetail({ title: "Write a.txt", kind: "edit" })).toEqual({ toolName: "edit_file" });
  });

  it("leaves a call it cannot name unchanged", () => {
    expect(antigravityToolDetail({ title: "Something", kind: "other" })).toBeNull();
    expect(antigravityToolDetail({ title: "runner_extra_write_file", kind: "other", _meta: { mcp: { tool: "write_file", server: "runner_extra" } } })).toBeNull();
  });
});
