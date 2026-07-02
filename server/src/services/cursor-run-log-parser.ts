export type ParsedCursorRunLogEvent =
  | {
      kind: "init";
      sessionId: string;
      agentId: string;
      runId: string;
      model?: string;
    }
  | {
      kind: "git";
      runId: string;
      agentId: string;
      branches: Array<{ repoUrl: string; branch?: string; prUrl?: string }>;
      source: string;
    }
  | {
      kind: "tool";
      runId: string;
      phase: string;
      toolName: string;
      toolUseId?: string;
    }
  | {
      kind: "result";
      status: string;
      phantomSuccess?: boolean;
      prUrl?: string;
    };

function tryParseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseCursorCloudLogChunk(chunk: string): ParsedCursorRunLogEvent[] {
  const events: ParsedCursorRunLogEvent[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    const record = tryParseJsonLine(line);
    if (!record || typeof record.type !== "string" || !record.type.startsWith("cursor_cloud.")) {
      continue;
    }
    switch (record.type) {
      case "cursor_cloud.init": {
        const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
        const agentId = typeof record.agentId === "string" ? record.agentId : sessionId;
        const runId = typeof record.runId === "string" ? record.runId : "";
        if (!sessionId || !runId) break;
        events.push({
          kind: "init",
          sessionId,
          agentId,
          runId,
          ...(typeof record.model === "string" ? { model: record.model } : {}),
        });
        break;
      }
      case "cursor_cloud.git": {
        const runId = typeof record.runId === "string" ? record.runId : "";
        const agentId = typeof record.agentId === "string" ? record.agentId : "";
        const branchesRaw = Array.isArray(record.branches) ? record.branches : [];
        const branches: Array<{ repoUrl: string; branch?: string; prUrl?: string }> = [];
        for (const entry of branchesRaw) {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
          const branchRec = entry as Record<string, unknown>;
          const repoUrl = typeof branchRec.repoUrl === "string" ? branchRec.repoUrl : "";
          if (!repoUrl) continue;
          branches.push({
            repoUrl,
            ...(typeof branchRec.branch === "string" ? { branch: branchRec.branch } : {}),
            ...(typeof branchRec.prUrl === "string" ? { prUrl: branchRec.prUrl } : {}),
          });
        }
        if (!runId) break;
        events.push({
          kind: "git",
          runId,
          agentId,
          branches,
          source: typeof record.source === "string" ? record.source : "sse_result",
        });
        break;
      }
      case "cursor_cloud.tool": {
        const runId = typeof record.runId === "string" ? record.runId : "";
        const toolName = typeof record.toolName === "string" ? record.toolName : "unknown";
        const phase = typeof record.phase === "string" ? record.phase : "started";
        if (!runId) break;
        events.push({
          kind: "tool",
          runId,
          phase,
          toolName,
          ...(typeof record.toolUseId === "string" ? { toolUseId: record.toolUseId } : {}),
        });
        break;
      }
      case "cursor_cloud.result": {
        const status = typeof record.status === "string" ? record.status : "unknown";
        const git = record.git as { branches?: Array<{ prUrl?: string }> } | undefined;
        let prUrl: string | undefined;
        if (git?.branches) {
          for (const branch of git.branches) {
            if (typeof branch?.prUrl === "string" && branch.prUrl.trim()) {
              prUrl = branch.prUrl.trim();
              break;
            }
          }
        }
        events.push({
          kind: "result",
          status,
          ...(record.phantomSuccess === true ? { phantomSuccess: true } : {}),
          ...(prUrl ? { prUrl } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return events;
}

export function cursorRunLogEventToRunEvent(
  event: ParsedCursorRunLogEvent,
): {
  eventType: string;
  stream: "stdout";
  level: "info" | "warn" | "error";
  message: string;
  payload: Record<string, unknown>;
} | null {
  switch (event.kind) {
    case "init":
      return {
        eventType: "cursor.init",
        stream: "stdout",
        level: "info",
        message: `Cursor cloud agent ${event.agentId} run ${event.runId}`,
        payload: {
          sessionId: event.sessionId,
          agentId: event.agentId,
          runId: event.runId,
          ...(event.model ? { model: event.model } : {}),
        },
      };
    case "git": {
      const prUrl = event.branches.find((b) => b.prUrl)?.prUrl;
      return {
        eventType: prUrl ? "git.pr_opened" : "cursor.git",
        stream: "stdout",
        level: "info",
        message: prUrl ? `Pull request: ${prUrl}` : "Cursor git update",
        payload: {
          runId: event.runId,
          agentId: event.agentId,
          branches: event.branches,
          source: event.source,
          ...(prUrl ? { prUrl } : {}),
        },
      };
    }
    case "tool":
      return {
        eventType: "cursor.tool",
        stream: "stdout",
        level: event.phase === "error" ? "error" : "info",
        message: `Tool ${event.toolName} (${event.phase})`,
        payload: {
          runId: event.runId,
          phase: event.phase,
          toolName: event.toolName,
          ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
        },
      };
    case "result":
      return {
        eventType: "cursor.result",
        stream: "stdout",
        level: event.status === "finished" && !event.phantomSuccess ? "info" : "warn",
        message: `Cursor run ${event.status}`,
        payload: {
          status: event.status,
          ...(event.phantomSuccess ? { phantomSuccess: true } : {}),
          ...(event.prUrl ? { prUrl: event.prUrl } : {}),
        },
      };
    default:
      return null;
  }
}
