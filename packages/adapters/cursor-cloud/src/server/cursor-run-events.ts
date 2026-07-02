export type CursorCloudInitEvent = {
  type: "cursor_cloud.init";
  sessionId: string;
  agentId: string;
  runId: string;
  model?: string;
};

export type CursorCloudGitEvent = {
  type: "cursor_cloud.git";
  runId: string;
  agentId: string;
  branches: Array<{
    repoUrl: string;
    branch?: string;
    prUrl?: string;
  }>;
  source: "sse_result" | "get_run" | "webhook_v0";
};

export type CursorCloudToolEvent = {
  type: "cursor_cloud.tool";
  runId: string;
  phase: "started" | "completed" | "error";
  toolName: string;
  toolUseId?: string;
  summary?: string;
};

export type CursorCloudEvent =
  | CursorCloudInitEvent
  | CursorCloudGitEvent
  | CursorCloudToolEvent
  | { type: "cursor_cloud.status"; status: string; message?: string }
  | {
      type: "cursor_cloud.result";
      status: string;
      result?: string;
      model?: string;
      durationMs?: number;
      git?: unknown;
      error?: string;
      phantomSuccess?: boolean;
    }
  | { type: "cursor_cloud.message"; message: unknown };

export function eventLine(event: CursorCloudEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function flattenPrUrl(git: unknown): string | null {
  const record = git as { branches?: Array<{ prUrl?: string }> } | null;
  const branches = record?.branches;
  if (!Array.isArray(branches)) return null;
  for (const branch of branches) {
    if (typeof branch?.prUrl === "string" && branch.prUrl.trim()) {
      return branch.prUrl.trim();
    }
  }
  return null;
}

const BC_ID_RE = /^bc-[0-9a-f-]{36}$/i;

export function isCursorCloudAgentId(value: string): boolean {
  return BC_ID_RE.test(value.trim());
}
