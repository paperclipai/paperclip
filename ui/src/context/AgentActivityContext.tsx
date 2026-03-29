import { createContext, useContext } from "react";

export interface AgentActivity {
  /** The tool currently being used (e.g. "Read", "Edit", "Bash") */
  toolName: string;
  /** File path being operated on, if detectable */
  filePath: string | null;
  /** Timestamp of the last detected activity */
  updatedAt: number;
}

const AgentActivityContext = createContext<Map<string, AgentActivity>>(new Map());

export function useAgentActivity(): Map<string, AgentActivity> {
  return useContext(AgentActivityContext);
}

export { AgentActivityContext };

// ---------------------------------------------------------------------------
// Generic tool-call extraction from raw stdout JSON lines.
// Works across Claude, Codex, and other adapters without needing adapter type.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractFilePath(input: unknown): string | null {
  const rec = asRecord(input);
  if (!rec) return null;
  if (typeof rec.file_path === "string") return rec.file_path;
  if (typeof rec.path === "string") return rec.path;
  if (typeof rec.pattern === "string") return rec.pattern;
  return null;
}

function findToolCallInObject(obj: Record<string, unknown>): { toolName: string; filePath: string | null } | null {
  // Claude format: type="assistant", message.content[] has tool_use blocks
  if (obj.type === "assistant") {
    const message = asRecord(obj.message);
    const content = Array.isArray(message?.content) ? message!.content : [];
    for (let i = content.length - 1; i >= 0; i--) {
      const block = asRecord(content[i]);
      if (block?.type === "tool_use" && typeof block.name === "string") {
        return { toolName: block.name, filePath: extractFilePath(block.input) };
      }
    }
  }

  // Codex format: type="item.started", item has type/name
  if (obj.type === "item.started" || obj.type === "item.completed") {
    const item = asRecord(obj.item);
    if (item?.type === "tool_use" && typeof item.name === "string") {
      return { toolName: item.name, filePath: extractFilePath(item.input) };
    }
    if (item?.type === "command_execution") {
      return { toolName: "command_execution", filePath: null };
    }
  }

  // OpenCode/other: direct tool_call kind
  if ((obj.type === "tool_call" || obj.kind === "tool_call") && typeof obj.name === "string") {
    return { toolName: obj.name, filePath: extractFilePath(obj.input) };
  }

  return null;
}

/**
 * Parse a raw stdout chunk for the most recent tool call.
 * Maintains a line buffer per run for handling partial lines across chunks.
 */
export function extractToolActivity(
  chunk: string,
  lineBuffer: Map<string, string>,
  runId: string,
): { toolName: string; filePath: string | null } | null {
  const prev = lineBuffer.get(runId) ?? "";
  const combined = prev + chunk;
  const lines = combined.split("\n");
  lineBuffer.set(runId, lines.pop() ?? "");

  // Scan lines in reverse — most recent tool call wins
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    // Quick string check before JSON.parse
    if (
      !trimmed.includes("tool_use") &&
      !trimmed.includes("tool_call") &&
      !trimmed.includes("command_execution")
    ) continue;

    try {
      const obj = asRecord(JSON.parse(trimmed));
      if (!obj) continue;
      const result = findToolCallInObject(obj);
      if (result) return result;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  Read: "Reading",
  Edit: "Editing",
  Write: "Writing",
  Bash: "Running",
  Grep: "Searching",
  Glob: "Finding files",
  Agent: "Delegating",
  WebSearch: "Searching web",
  WebFetch: "Fetching",
  TodoWrite: "Planning",
  Skill: "Using skill",
  NotebookEdit: "Editing notebook",
  command_execution: "Running command",
};

const TOOL_COLORS: Record<string, string> = {
  Read: "text-blue-500",
  Edit: "text-amber-500",
  Write: "text-amber-500",
  Bash: "text-emerald-500",
  Grep: "text-cyan-500",
  Glob: "text-cyan-500",
  Agent: "text-purple-500",
  command_execution: "text-emerald-500",
};

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

export function toolColor(toolName: string): string {
  return TOOL_COLORS[toolName] ?? "text-primary";
}

export function formatActivity(activity: AgentActivity): string {
  const label = toolLabel(activity.toolName);
  if (activity.filePath) {
    const short = activity.filePath.split("/").pop() ?? activity.filePath;
    return `${label} ${short}`;
  }
  return label;
}
