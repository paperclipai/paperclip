import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

type SessionKeyStrategy = "fixed" | "issue" | "run";
type HermesApiMode = "chat_completions" | "responses";

type WakePayload = {
  runId: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function buildWakePayload(ctx: AdapterExecutionContext): WakePayload {
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

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const normalized = asString(value, "issue").trim().toLowerCase();
  if (normalized === "fixed" || normalized === "run") return normalized;
  return "issue";
}

function resolveConversationKey(input: {
  strategy: SessionKeyStrategy;
  configuredSessionKey: string | null;
  agentId: string;
  runId: string;
  issueId: string | null;
}) {
  const fallback = input.configuredSessionKey ?? `paperclip:agent:${input.agentId}`;
  if (input.strategy === "run") {
    return `paperclip:agent:${input.agentId}:run:${input.runId}`;
  }
  if (input.strategy === "issue" && input.issueId) {
    return `paperclip:agent:${input.agentId}:issue:${input.issueId}`;
  }
  return fallback;
}

function resolveApiMode(config: Record<string, unknown>, url: string): HermesApiMode {
  const explicit = asString(config.apiMode, "").trim().toLowerCase();
  if (explicit === "responses") return "responses";
  if (explicit === "chat" || explicit === "chat_completions") return "chat_completions";
  if (url.endsWith("/v1/responses")) return "responses";
  return "chat_completions";
}

function deriveResponsesUrl(url: string): string {
  if (url.endsWith("/v1/responses")) return url;
  if (url.endsWith("/v1/chat/completions")) {
    return `${url.slice(0, -"/chat/completions".length)}/responses`;
  }
  if (url.endsWith("/chat/completions")) {
    return `${url.slice(0, -"/chat/completions".length)}/responses`;
  }
  return url;
}

function buildPaperclipContextPrompt(ctx: AdapterExecutionContext, wakePayload: WakePayload): string {
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
    "- Prefer Hermes plugin tools named paperclip_* when they are available in this runtime.",
    "- If Paperclip plugin tools are not available, use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API call.",
    "- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every mutating Paperclip API call.",
    "- Use the configured PAPERCLIP_API_URL as the API base.",
    "- Operate on the current task or issue only; do not continue unrelated prior work unless the current issue explicitly requires it.",
    "",
    "Workflow:",
    "1) Get your identity and current task context.",
    `2) Determine issueId: PAPERCLIP_TASK_ID if present, otherwise issue_id (${issueIdHint}).`,
    "3) If issueId exists:",
    "   - Checkout the issue before doing work.",
    "   - Read the issue and comments or heartbeat context.",
    "   - Execute the issue instructions in this run.",
    "   - Leave durable progress using Paperclip APIs or paperclip_* tools.",
    "   - If blocked, mark the issue blocked with a clear unblock owner and next action.",
    "   - If work is complete, mark the issue done with a concise completion comment.",
    "   - If the issue needs a visible update, add an issue comment.",
    "   - Use child issues for follow-up or parallel work.",
    "   - Use request_confirmation or other issue interactions for structured user or board decisions.",
    "",
    "Preferred Paperclip tools when available:",
    "- paperclip_get_agent_me",
    "- paperclip_list_assigned_issues",
    "- paperclip_get_issue",
    "- paperclip_get_issue_heartbeat_context",
    "- paperclip_get_issue_comments",
    "- paperclip_checkout_issue",
    "- paperclip_add_issue_comment",
    "- paperclip_update_issue",
    "- paperclip_create_child_issue",
    "- paperclip_create_interaction",
    "- paperclip_get_approval",
    "- paperclip_get_approval_issues",
    "- paperclip_create_board_approval",
    "- paperclip_get_issue_workspace_runtime",
    "- paperclip_control_issue_workspace_services",
    "",
    "Issue completion standard:",
    "- Freeform prose alone is not enough when issue state must advance.",
    "- Prefer durable state changes in Paperclip over only responding in chat.",
  ];

  if (structuredWakePrompt) {
    lines.push("", structuredWakePrompt);
  }
  if (structuredWakeJson) {
    lines.push("", "Structured wake payload JSON:", structuredWakeJson);
  }

  return lines.join("\n");
}

function extractChatSummary(data: any): string {
  return data?.choices?.[0]?.message?.content || "[No content returned]";
}

function extractResponsesSummary(data: any): string {
  const output = Array.isArray(data?.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (item?.type !== "message" || item?.role !== "assistant") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === "output_text" && typeof block?.text === "string" && block.text.trim().length > 0) {
        parts.push(block.text.trim());
      }
    }
  }
  return parts.join("\n\n") || "[No content returned]";
}

function extractResponsesModel(data: any): string | null {
  return typeof data?.model === "string" && data.model.trim().length > 0 ? data.model.trim() : null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, onLog, onMeta } = ctx;

  const configuredUrl = asString(config.url, "http://localhost:8080/v1/chat/completions");
  const apiMode = resolveApiMode(config, configuredUrl);
  const requestUrl = apiMode === "responses" ? deriveResponsesUrl(configuredUrl) : configuredUrl;
  const apiKey = asString(config.apiKey, "");
  const model = asString(config.model, "").trim();
  const timeoutMs = asNumber(config.timeoutSec, 300) * 1000;
  const sessionKeyStrategy = normalizeSessionKeyStrategy(config.sessionKeyStrategy);
  const configuredSessionKey = nonEmpty(config.sessionKey);
  const useStoredResponses = apiMode === "responses" && parseBoolean(config.storeResponses, true);

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );

  const wakePayload = buildWakePayload(ctx);
  const conversationKey = resolveConversationKey({
    strategy: sessionKeyStrategy,
    configuredSessionKey,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    issueId: wakePayload.issueId,
  });
  const prompt = promptTemplate.replace("{{agent.id}}", ctx.agent.id).replace("{{agent.name}}", ctx.agent.name);
  const paperclipContextPrompt = buildPaperclipContextPrompt(ctx, wakePayload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Paperclip-Run-Id": ctx.runId,
    "X-Paperclip-Agent-Id": ctx.agent.id,
    "X-Paperclip-Company-Id": ctx.agent.companyId,
    "Idempotency-Key": ctx.runId,
  };
  if (wakePayload.issueId) headers["X-Paperclip-Issue-Id"] = wakePayload.issueId;
  if (wakePayload.taskId) headers["X-Paperclip-Task-Id"] = wakePayload.taskId;
  if (wakePayload.wakeReason) headers["X-Paperclip-Wake-Reason"] = wakePayload.wakeReason;

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (onMeta) {
    await onMeta({
      adapterType: "hermes_gateway",
      command: `fetch ${requestUrl}`,
      commandArgs: [
        "--api-mode",
        apiMode,
        ...(conversationKey ? ["--conversation", conversationKey] : []),
        ...(model ? ["--model", model] : []),
      ],
      prompt,
      context: {
        ...ctx.context,
        hermesApiMode: apiMode,
        hermesConversation: conversationKey,
      },
    });
  }

  try {
    const startTime = Date.now();
    await onLog(
      "stdout",
      `[paperclip] Invoking Hermes Agent via ${apiMode} at ${requestUrl}${
        apiMode === "responses" ? ` (conversation=${conversationKey})` : ""
      }\n`,
    );

    const requestBody: Record<string, unknown> =
      apiMode === "responses"
        ? {
            input: prompt,
            instructions: ["You are an autonomous agent orchestrated by Paperclip.", paperclipContextPrompt].join(
              "\n\n",
            ),
            stream: false,
            store: useStoredResponses,
            conversation: conversationKey,
          }
        : {
            messages: [
              {
                role: "system",
                content: ["You are an autonomous agent orchestrated by Paperclip.", paperclipContextPrompt].join(
                  "\n\n",
                ),
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
      response = await fetch(requestUrl, {
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
    const summary = apiMode === "responses" ? extractResponsesSummary(data) : extractChatSummary(data);
    const usage = data?.usage;

    await onLog("stdout", `[paperclip] Hermes replied successfully in ${Date.now() - startTime}ms.\n`);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      errorCode: null,
      provider: "hermes",
      model: (apiMode === "responses" ? extractResponsesModel(data) : data?.model) || model || null,
      resultJson: data,
      summary,
      usage: usage
        ? {
            inputTokens: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? usage.completion_tokens ?? 0),
          }
        : undefined,
      sessionParams:
        apiMode === "responses"
          ? {
              apiMode,
              conversation: conversationKey,
              lastResponseId: nonEmpty(data?.id),
            }
          : null,
      sessionDisplayId: apiMode === "responses" ? conversationKey : null,
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
