import type { Run } from "@cursor/sdk";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { classifyCursorApiError } from "./cursor-api-retry.js";
import { eventLine, type CursorCloudGitEvent, type CursorCloudToolEvent } from "./cursor-run-events.js";

type ObserveRunStreamInput = {
  run: Run;
  agentId: string;
  onLog: AdapterExecutionContext["onLog"];
  pollIntervalMs?: number;
  getRunFallback?: () => Promise<{
    status: string;
    git?: { branches: Array<{ repoUrl: string; branch?: string; prUrl?: string }> };
  } | null>;
};

function extractToolFromMessage(message: unknown): CursorCloudToolEvent | null {
  const record = message as Record<string, unknown>;
  if (record.type !== "tool_call") return null;
  const toolCall = record.tool_call as Record<string, unknown> | undefined;
  const toolUse = toolCall?.tool_use as Record<string, unknown> | undefined;
  const name = typeof toolUse?.name === "string" ? toolUse.name : "unknown";
  const status = typeof toolCall?.status === "string" ? toolCall.status : "started";
  const phase =
    status === "completed" ? "completed" : status === "error" ? "error" : "started";
  return {
    type: "cursor_cloud.tool",
    runId: "",
    phase,
    toolName: name,
    toolUseId: typeof toolUse?.id === "string" ? toolUse.id : undefined,
  };
}

export async function observeRunStream(input: ObserveRunStreamInput): Promise<void> {
  const { run, agentId, onLog } = input;
  if (!run.supports("stream")) return;

  try {
    for await (const message of run.stream()) {
      const record = message as unknown as Record<string, unknown>;
      if (record.type === "result") {
        const git = (record as { git?: CursorCloudGitEvent["branches"] }).git;
        if (git && Array.isArray(git) && git.length > 0) {
          const gitEvent: CursorCloudGitEvent = {
            type: "cursor_cloud.git",
            runId: run.id,
            agentId,
            branches: git as CursorCloudGitEvent["branches"],
            source: "sse_result",
          };
          await onLog("stdout", eventLine(gitEvent));
        }
      }
      const toolEvent = extractToolFromMessage(message);
      if (toolEvent) {
        toolEvent.runId = run.id;
        await onLog("stdout", eventLine(toolEvent));
      }
      await onLog("stdout", eventLine({ type: "cursor_cloud.message", message }));
    }
  } catch (err) {
    const classified = classifyCursorApiError(err);
    if (classified.kind === "stream_expired" && input.getRunFallback) {
      await onLog(
        "stdout",
        eventLine({ type: "cursor_cloud.status", status: "stream_expired" }),
      );
      const snapshot = await input.getRunFallback();
      if (snapshot?.git?.branches?.length) {
        await onLog(
          "stdout",
          eventLine({
            type: "cursor_cloud.git",
            runId: run.id,
            agentId,
            branches: snapshot.git.branches,
            source: "get_run",
          }),
        );
      }
      return;
    }
    throw err;
  }
}
