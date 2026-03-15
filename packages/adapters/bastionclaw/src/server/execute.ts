import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function sqliteQuery(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf-8",
    timeout: 5_000,
  }).trim();
}

interface WakePayload {
  runId: string;
  agentId: string;
  companyId: string;
  taskId: string;
  issueId: string;
  wakeReason: string;
  wakeCommentId: string;
  approvalId: string;
  approvalStatus: string;
  issueIds: string;
  apiUrl: string;
}

function buildWakeText(p: WakePayload): string {
  const envEntries: [string, string][] = [
    ["PAPERCLIP_RUN_ID", p.runId],
    ["PAPERCLIP_AGENT_ID", p.agentId],
    ["PAPERCLIP_COMPANY_ID", p.companyId],
    ["PAPERCLIP_API_URL", p.apiUrl],
    ["PAPERCLIP_TASK_ID", p.taskId],
    ["PAPERCLIP_WAKE_REASON", p.wakeReason],
    ["PAPERCLIP_WAKE_COMMENT_ID", p.wakeCommentId],
    ["PAPERCLIP_APPROVAL_ID", p.approvalId],
    ["PAPERCLIP_APPROVAL_STATUS", p.approvalStatus],
    ["PAPERCLIP_LINKED_ISSUE_IDS", p.issueIds],
  ];
  const envLines = envEntries
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`);

  const issueIdHint = p.taskId || p.issueId || "";

  return [
    "Paperclip wake event.",
    "",
    "Run this procedure now. Do not guess undocumented endpoints.",
    "",
    "Your run context:",
    ...envLines,
    "",
    `task_id=${p.taskId}`,
    `issue_id=${p.issueId}`,
    `wake_reason=${p.wakeReason}`,
    `wake_comment_id=${p.wakeCommentId}`,
    `approval_id=${p.approvalId}`,
    `approval_status=${p.approvalStatus}`,
    `linked_issue_ids=${p.issueIds}`,
    "",
    "IMPORTANT: Use the mcp__bastionclaw__paperclip_api tool for ALL Paperclip API calls.",
    "Do NOT use curl or direct HTTP requests — the Paperclip API is only reachable through the MCP proxy.",
    "Authentication and X-Paperclip-Run-Id headers are injected automatically by the proxy.",
    "",
    "Workflow:",
    `1) Call paperclip_api with method=GET path=/api/agents/me`,
    `2) Determine issueId: PAPERCLIP_TASK_ID if present, otherwise issue_id (${issueIdHint}).`,
    "3) If issueId exists:",
    '   - paperclip_api method=POST path=/api/issues/{issueId}/checkout body={"agentId":"$PAPERCLIP_AGENT_ID","expectedStatuses":["todo","backlog","blocked"]}',
    "   - paperclip_api method=GET path=/api/issues/{issueId}",
    "   - paperclip_api method=GET path=/api/issues/{issueId}/comments",
    "   - Execute the issue instructions exactly.",
    '   - If instructions require a comment: paperclip_api method=POST path=/api/issues/{issueId}/comments body={"body":"..."}',
    '   - paperclip_api method=PATCH path=/api/issues/{issueId} body={"status":"done","comment":"what changed and why"}',
    "4) If issueId does not exist:",
    `   - paperclip_api method=GET path=/api/companies/${p.companyId}/issues?assigneeAgentId=${p.agentId}&status=todo,in_progress,blocked`,
    "   - Pick in_progress first, then todo, then blocked, then execute step 3.",
    "",
    "Complete the workflow in this run.",
  ].join("\n");
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.config);
  const context = parseObject(ctx.context);

  const bastionclawRoot = asString(config.bastionclaw_root, "").trim();
  if (!bastionclawRoot) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Missing bastionclaw_root in adapter config",
      errorCode: "bastionclaw_config_missing",
    };
  }

  const timeoutSec = Math.max(30, Math.floor(asNumber(config.timeout_sec, 1800)));
  const pollIntervalSec = Math.max(1, Math.floor(asNumber(config.poll_interval_sec, 5)));
  const targetJid = asString(config.target_jid, "").trim();

  // Build a deterministic task ID from the Paperclip run ID
  const taskId = `paperclip-${ctx.runId}`;

  // Build Paperclip wake payload (matches openclaw-gateway pattern)
  const agentId = ctx.agent.id;
  const companyId = ctx.agent.companyId;
  const issueId = asString(context.issueId, "");
  const taskIdCtx = asString(context.taskId, "") || issueId;
  const wakeReason = asString(context.wakeReason, "");
  const commentId = asString(context.wakeCommentId, "") || asString(context.commentId, "");
  const approvalId = asString(context.approvalId, "");
  const approvalStatus = asString(context.approvalStatus, "");
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? (context.issueIds as string[]).filter((v): v is string => typeof v === "string").join(",")
    : "";

  const runtimeHost = process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost";
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const paperclipApiUrl = process.env.PAPERCLIP_API_URL ?? `http://${runtimeHost}:${runtimePort}`;

  const prompt = buildWakeText({
    runId: ctx.runId,
    agentId,
    companyId,
    taskId: taskIdCtx,
    issueId,
    wakeReason,
    wakeCommentId: commentId,
    approvalId,
    approvalStatus,
    issueIds: linkedIssueIds,
    apiUrl: paperclipApiUrl,
  });

  // Write IPC task file
  const ipcTasksDir = join(bastionclawRoot, "data", "ipc", "main", "tasks");
  mkdirSync(ipcTasksDir, { recursive: true });

  const taskPayload: Record<string, unknown> = {
    type: "schedule_task",
    taskId,
    prompt,
    schedule_type: "once",
    schedule_value: new Date().toISOString(),
    context_mode: "isolated",
  };
  if (targetJid) {
    taskPayload.targetJid = targetJid;
  } else {
    // Need a target JID — query the DB for the main group's JID
    const dbPath = join(bastionclawRoot, "store", "messages.db");
    try {
      const result = sqliteQuery(
        dbPath,
        "SELECT jid FROM registered_groups WHERE folder = 'main' LIMIT 1",
      );
      const rows = JSON.parse(result || "[]") as { jid: string }[];
      if (rows.length > 0) {
        taskPayload.targetJid = rows[0].jid;
      }
    } catch {
      // Fall through — BastionClaw will reject if no targetJid
    }
  }

  if (!taskPayload.targetJid) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Could not determine target JID. Set target_jid in adapter config or ensure a main group is registered.",
      errorCode: "bastionclaw_no_target_jid",
    };
  }

  const taskFileName = `${taskId}-${Date.now()}.json`;
  const taskFilePath = join(ipcTasksDir, taskFileName);
  writeFileSync(taskFilePath, JSON.stringify(taskPayload));

  await ctx.onLog("stdout", `Task ${taskId} written to BastionClaw IPC\n`);

  // Poll SQLite for task completion
  const dbPath = join(bastionclawRoot, "store", "messages.db");
  const startTime = Date.now();
  const deadlineMs = timeoutSec * 1000;
  const pollIntervalMs = pollIntervalSec * 1000;

  while (Date.now() - startTime < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const result = sqliteQuery(
        dbPath,
        `SELECT status, result, error, duration_ms FROM task_run_logs WHERE task_id = '${taskId.replace(/'/g, "''")}' ORDER BY run_at DESC LIMIT 1`,
      );

      const rows = JSON.parse(result || "[]") as {
        status: string;
        result: string | null;
        error: string | null;
        duration_ms: number;
      }[];

      if (rows.length > 0) {
        const row = rows[0];
        if (row.status === "success") {
          const resultText = (row.result ?? "Task completed")
            .replace(/<internal>[\s\S]*?<\/internal>/g, "")
            .trim() || "Task completed";
          await ctx.onLog("stdout", `Task completed in ${row.duration_ms}ms\n`);
          await ctx.onLog("stdout", resultText + "\n");
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            provider: "bastionclaw",
            summary: resultText,
            resultJson: { taskId, result: resultText, duration_ms: row.duration_ms },
          };
        } else if (row.status === "error") {
          await ctx.onLog("stderr", `Task failed: ${row.error ?? "unknown error"}\n`);
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: row.error ?? "Task failed",
            errorCode: "bastionclaw_task_error",
            resultJson: { taskId, error: row.error, duration_ms: row.duration_ms },
          };
        }
      }
    } catch {
      // SQLite query failed — DB might be locked, retry
    }
  }

  // Timeout
  await ctx.onLog("stderr", `Task ${taskId} timed out after ${timeoutSec}s\n`);
  return {
    exitCode: 1,
    signal: null,
    timedOut: true,
    errorMessage: `Task did not complete within ${timeoutSec} seconds`,
    errorCode: "bastionclaw_timeout",
    resultJson: { taskId },
  };
}
