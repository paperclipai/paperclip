import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildWakePayload(ctx: AdapterExecutionContext) {
  const { runId, agent, context } = ctx;
  return {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    taskId: nonEmpty(context.taskId) ?? nonEmpty(context.issueId),
    issueId: nonEmpty(context.issueId),
    wakeReason: nonEmpty(context.wakeReason),
    wakeCommentId: nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId),
    approvalId: nonEmpty(context.approvalId),
    approvalStatus: nonEmpty(context.approvalStatus),
    issueIds: Array.isArray(context.issueIds)
      ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [],
  };
}

function buildPaperclipContextPrompt(ctx: AdapterExecutionContext): string {
  const wakePayload = buildWakePayload(ctx);
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
  };

  if (wakePayload.taskId) paperclipEnv.PAPERCLIP_TASK_ID = wakePayload.taskId;
  if (wakePayload.wakeReason) paperclipEnv.PAPERCLIP_WAKE_REASON = wakePayload.wakeReason;
  if (wakePayload.wakeCommentId) paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID = wakePayload.wakeCommentId;
  if (wakePayload.approvalId) paperclipEnv.PAPERCLIP_APPROVAL_ID = wakePayload.approvalId;
  if (wakePayload.approvalStatus) paperclipEnv.PAPERCLIP_APPROVAL_STATUS = wakePayload.approvalStatus;
  if (wakePayload.issueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = wakePayload.issueIds.join(",");
  }

  const structuredWakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  const structuredWakeJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake);
  const envKeys = [
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_TASK_ID",
    "PAPERCLIP_WAKE_REASON",
    "PAPERCLIP_WAKE_COMMENT_ID",
    "PAPERCLIP_APPROVAL_ID",
    "PAPERCLIP_APPROVAL_STATUS",
    "PAPERCLIP_LINKED_ISSUE_IDS",
  ];
  const envLines = envKeys
    .map((key) => (paperclipEnv[key] ? `${key}=${paperclipEnv[key]}` : null))
    .filter((value): value is string => Boolean(value));

  const issueIdHint = wakePayload.taskId ?? wakePayload.issueId ?? "";
  const lines = [
    "Paperclip execution context:",
    ...envLines,
    "",
    "Paperclip API rules:",
    "- Use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API call.",
    "- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every mutating Paperclip API call.",
    "- Use the configured PAPERCLIP_API_URL as the API base.",
    "- Operate on the current task or issue only; do not continue unrelated prior work unless the current issue explicitly requires it.",
    "",
    "Workflow:",
    "1) GET /api/agents/me",
    `2) Determine issueId: PAPERCLIP_TASK_ID if present, otherwise issue_id (${issueIdHint}).`,
    "3) If issueId exists:",
    "   - GET /api/issues/{issueId}",
    "   - GET /api/issues/{issueId}/comments",
    "   - Execute the issue instructions in this run.",
    "   - Leave durable progress using Paperclip APIs when appropriate.",
    "   - If blocked, PATCH /api/issues/{issueId} with status blocked and a clear unblock comment.",
    "   - If work is complete, PATCH /api/issues/{issueId} with status done and a concise completion comment.",
    "   - If the issue needs a visible update, POST /api/issues/{issueId}/comments.",
    "",
    "Useful endpoints:",
    "- GET /api/issues/{issueId}",
    "- GET /api/issues/{issueId}/comments",
    "- POST /api/issues/{issueId}/comments",
    "- PATCH /api/issues/{issueId}",
  ];

  if (structuredWakePrompt) {
    lines.push("", structuredWakePrompt);
  }
  if (structuredWakeJson) {
    lines.push("", "Structured wake payload JSON:", structuredWakeJson);
  }

  return lines.join("\n");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, onLog, onMeta } = ctx;

  const url = asString(config.url, "http://localhost:8080/v1/chat/completions");
  const apiKey = asString(config.apiKey, "");
  const model = asString(config.model, "").trim();
  const timeoutMs = asNumber(config.timeoutSec, 300) * 1000;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );

  const prompt = promptTemplate.replace("{{agent.id}}", ctx.agent.id).replace("{{agent.name}}", ctx.agent.name);
  const paperclipContextPrompt = buildPaperclipContextPrompt(ctx);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Paperclip-Run-Id": ctx.runId,
    "X-Paperclip-Agent-Id": ctx.agent.id,
    "X-Paperclip-Company-Id": ctx.agent.companyId,
  };
  const issueId = nonEmpty(ctx.context.issueId);
  const taskId = nonEmpty(ctx.context.taskId);
  const wakeReason = nonEmpty(ctx.context.wakeReason);
  if (issueId) headers["X-Paperclip-Issue-Id"] = issueId;
  if (taskId) headers["X-Paperclip-Task-Id"] = taskId;
  if (wakeReason) headers["X-Paperclip-Wake-Reason"] = wakeReason;

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (onMeta) {
    await onMeta({
      adapterType: "hermes_gateway",
      command: `fetch ${url}`,
      commandArgs: model ? ["--model", model] : [],
      prompt,
      context: ctx.context,
    });
  }

  try {
    const startTime = Date.now();
    await onLog("stdout", `[paperclip] Invoking Hermes Agent at ${url}\n`);

    const requestBody: Record<string, unknown> = {
      messages: [
        {
          role: "system",
          content: ["You are an autonomous agent orchestrated by Paperclip.", paperclipContextPrompt].join("\n\n"),
        },
        { role: "user", content: prompt },
      ],
      stream: false,
    };
    if (model) {
      requestBody.model = model;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorText = await response.text();
      await onLog("stderr", `[paperclip] Hermes API Error: ${response.status} - ${errorText}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Hermes API Error: ${response.status}`,
        errorCode: "hermes_api_error",
        clearSession: true,
      };
    }

    const data = (await response.json()) as any;
    const summary = data.choices?.[0]?.message?.content || "[No content returned]";
    const costUsd = data.usage?.total_cost_usd ?? 0;

    await onLog("stdout", `[paperclip] Hermes replied successfully in ${Date.now() - startTime}ms.\n`);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      errorCode: null,
      provider: "hermes",
      model: data.model || model || null,
      resultJson: data,
      summary,
      costUsd,
      clearSession: false,
    };
  } catch (error: any) {
    const timedOut = error?.name === "AbortError";
    await onLog("stderr", `[paperclip] Failed to invoke Hermes: ${error.message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut,
      errorMessage: `Failed to invoke Hermes: ${error.message}`,
      errorCode: timedOut ? "hermes_timeout" : "hermes_invoke_failed",
      clearSession: true,
    };
  }
}
