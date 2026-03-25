import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  appendWithCap,
} from "@paperclipai/adapter-utils/server-utils";

// ---------------------------------------------------------------------------
// Paperclip issue lifecycle helpers
// ---------------------------------------------------------------------------

const PAPERCLIP_BASE_URL = process.env.PAPERCLIP_INTERNAL_URL ?? "http://127.0.0.1:3100";

async function checkoutIssue(
  issueId: string,
  agentId: string,
  runId: string,
  authToken: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${PAPERCLIP_BASE_URL}/api/issues/${issueId}/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        "x-paperclip-run-id": runId,
      },
      body: JSON.stringify({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      }),
    });
    return res.ok || res.status === 409; // 409 = already checked out by same run
  } catch {
    return false;
  }
}

async function completeIssue(
  issueId: string,
  runId: string,
  authToken: string,
  summary: string,
): Promise<void> {
  try {
    await fetch(`${PAPERCLIP_BASE_URL}/api/issues/${issueId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        "x-paperclip-run-id": runId,
      },
      body: JSON.stringify({
        status: "done",
        ...(summary ? { comment: summary.slice(0, 2000) } : {}),
      }),
    });
  } catch {
    // Best-effort — the run itself succeeded even if status update fails
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUserMessage(ctx: AdapterExecutionContext): string {
  const context = parseObject(ctx.context);
  const parts: string[] = [];

  const title = asString(context.issueTitle as unknown, "");
  if (title) parts.push(`# ${title}`);

  const description = asString(context.issueBody as unknown, "");
  if (description) parts.push(description);

  // Goal ancestry chain (parent goals for context)
  const goals = context.goalAncestry;
  if (Array.isArray(goals) && goals.length > 0) {
    parts.push(
      "\n## Goal context\n" +
        goals
          .filter((g): g is { title: string } => typeof g === "object" && g !== null && "title" in g)
          .map((g) => `- ${g.title}`)
          .join("\n"),
    );
  }

  // Recent comments
  const comments = context.comments;
  if (Array.isArray(comments) && comments.length > 0) {
    parts.push(
      "\n## Recent comments\n" +
        comments
          .filter(
            (c): c is { author: string; body: string } =>
              typeof c === "object" && c !== null && "body" in c,
          )
          .map((c) => `**${c.author ?? "unknown"}**: ${c.body}`)
          .join("\n\n"),
    );
  }

  // Prompt template override
  const promptTemplate = asString(context.promptTemplate as unknown, "");
  if (promptTemplate) parts.push(`\n## Instructions\n${promptTemplate}`);

  return parts.length > 0 ? parts.join("\n\n") : "Complete the assigned task.";
}

interface SSEEvent {
  event?: string;
  data?: string;
}

async function* parseSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: SSEEvent = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent.event = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        currentEvent.data = line.slice(6);
      } else if (line === "") {
        if (currentEvent.event || currentEvent.data) {
          yield currentEvent;
        }
        currentEvent = {};
      }
    }
  }

  // Flush remaining
  if (buffer.trim()) {
    const remaining: SSEEvent = {};
    for (const line of buffer.split("\n")) {
      if (line.startsWith("event: ")) remaining.event = line.slice(7).trim();
      else if (line.startsWith("data: ")) remaining.data = line.slice(6);
    }
    if (remaining.event || remaining.data) yield remaining;
  }
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { config, onLog, onMeta } = ctx;

  const deerflowUrl = asString(config.deerflowUrl as unknown, "http://deerflow-langgraph:2024");
  const model = asString(config.model as unknown, "");
  const skill = asString(config.skill as unknown, "");
  const thinkingEnabled = asBoolean(config.thinkingEnabled as unknown, true);
  const subagentEnabled = asBoolean(config.subagentEnabled as unknown, true);
  const timeoutSec = asNumber(config.timeoutSec as unknown, 600);
  const recursionLimit = asNumber(config.recursionLimit as unknown, 100);
  const billingMode = asString(config.billingMode as unknown, "auto");
  // DeerFlow is always API-billed (calls a remote LangGraph endpoint); allow
  // explicit "subscription" override for self-hosted setups billed differently.
  const billingType: "api" | "subscription" =
    billingMode === "subscription" ? "subscription" : "api";

  // Resolve existing thread from session
  const sessionParams = parseObject(ctx.runtime.sessionParams);
  let threadId = asString(sessionParams.threadId as unknown, "");

  if (onMeta) {
    await onMeta({
      adapterType: "deerflow",
      command: `POST ${deerflowUrl}/threads/*/runs/stream`,
      context: { model, skill, thinkingEnabled, subagentEnabled },
    });
  }

  // Resolve issue context for checkout/completion
  const contextObj = parseObject(ctx.context);
  const issueId = asString(contextObj.issueId as unknown, "");
  const authToken = ctx.authToken ?? "";

  const controller = new AbortController();
  const timer = timeoutSec > 0 ? setTimeout(() => controller.abort(), timeoutSec * 1000) : null;

  let stdout = "";
  const usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
  let summary = "";
  let errorMessage: string | null = null;

  try {
    // 0. Checkout the issue if we have one
    if (issueId && authToken) {
      const checked = await checkoutIssue(issueId, ctx.agent.id, ctx.runId, authToken);
      if (checked) {
        await onLog("stdout", `[deerflow] Checked out issue ${issueId}\n`);
      } else {
        await onLog("stderr", `[deerflow] Failed to checkout issue ${issueId}\n`);
      }
    }

    // 1. Create or reuse thread
    if (!threadId) {
      const threadRes = await fetch(`${deerflowUrl}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: { source: "paperclip", agentId: ctx.agent.id } }),
        signal: controller.signal,
      });
      if (!threadRes.ok) {
        throw new Error(`Failed to create DeerFlow thread: HTTP ${threadRes.status}`);
      }
      const threadData = (await threadRes.json()) as { thread_id: string };
      threadId = threadData.thread_id;
    }

    await onLog("stdout", `[deerflow] Thread: ${threadId}\n`);

    // 2. Build the message
    const userMessage = buildUserMessage(ctx);

    // 3. Stream the run
    const runBody = {
      assistant_id: "lead_agent",
      input: {
        messages: [{ role: "human", content: userMessage }],
      },
      config: {
        recursion_limit: recursionLimit,
      },
      context: {
        thread_id: threadId,
        ...(model ? { model_name: model } : {}),
        thinking_enabled: thinkingEnabled,
        subagent_enabled: subagentEnabled,
        ...(skill ? { skill_name: skill } : {}),
        paperclip_api_url: PAPERCLIP_BASE_URL,
        paperclip_company_id: ctx.agent.companyId,
        // Auth token is forwarded so DeerFlow agents can call back into the
        // Paperclip API (e.g. update issue status). This is safe because DeerFlow
        // runs on an isolated Docker network (agent-core-net) with no external access.
        ...(authToken ? { paperclip_auth_token: authToken } : {}),
      },
      stream_mode: ["messages-tuple", "values"],
    };

    const runRes = await fetch(`${deerflowUrl}/threads/${threadId}/runs/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(runBody),
      signal: controller.signal,
    });

    if (!runRes.ok) {
      const errBody = await runRes.text().catch(() => "");
      throw new Error(`DeerFlow run failed: HTTP ${runRes.status} ${errBody}`);
    }

    if (!runRes.body) {
      throw new Error("DeerFlow returned no response body");
    }

    // 4. Parse SSE stream
    const reader = runRes.body.getReader();
    let lastAiContent = "";
    let lastAiMessageId = "";

    for await (const sse of parseSSE(reader)) {
      if (!sse.data) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(sse.data);
      } catch {
        continue;
      }

      if (sse.event === "messages-tuple" || sse.event === "messages/partial") {
        // LangGraph streams messages as [messageType, messageData]
        const tuple = parsed as [string, Record<string, unknown>];
        if (!Array.isArray(tuple) || tuple.length < 2) continue;

        const [msgType, msgData] = tuple;

        if (msgType === "AIMessageChunk" || msgType === "AIMessage") {
          const content = asString(msgData.content as unknown, "");
          if (content) {
            await onLog("stdout", content);
            stdout = appendWithCap(stdout, content);
            // Accumulate chunks per message ID; reset when a new AI message starts
            const msgId = asString(msgData.id as unknown, "");
            if (msgId && msgId !== lastAiMessageId) {
              lastAiContent = "";
              lastAiMessageId = msgId;
            }
            lastAiContent += content;
          }

          // Tool calls in AI message
          const toolCalls = msgData.tool_calls;
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            for (const tc of toolCalls) {
              const tcObj = tc as Record<string, unknown>;
              const name = asString(tcObj.name as unknown, "unknown");
              await onLog("stdout", `\n[tool_call] ${name}\n`);
            }
          }

          // Usage info
          const usageData = msgData.usage_metadata as Record<string, unknown> | undefined;
          if (usageData) {
            usage.inputTokens += asNumber(usageData.input_tokens as unknown, 0);
            usage.outputTokens += asNumber(usageData.output_tokens as unknown, 0);
          }
        } else if (msgType === "ToolMessage") {
          const content = asString(msgData.content as unknown, "");
          if (content) {
            const truncated = content.length > 2000 ? content.slice(0, 2000) + "..." : content;
            await onLog("stdout", `[tool_result] ${truncated}\n`);
          }
        }
      } else if (sse.event === "values") {
        // Full state snapshot — extract artifacts, title, etc.
        const stateData = parsed as Record<string, unknown>;
        const title = asString(stateData.title as unknown, "");
        if (title) {
          await onLog("stdout", `\n[title] ${title}\n`);
        }
      } else if (sse.event === "end") {
        break;
      } else if (sse.event === "error") {
        const errData = parsed as Record<string, unknown>;
        errorMessage = asString(errData.message as unknown, "Unknown DeerFlow error");
        await onLog("stderr", `[error] ${errorMessage}\n`);
      }
    }

    summary = lastAiContent.slice(0, 500);

    // Mark issue as done on successful execution
    if (!errorMessage && issueId && authToken) {
      await completeIssue(issueId, ctx.runId, authToken, summary);
      await onLog("stdout", `\n[deerflow] Marked issue ${issueId} as done\n`);
    }

    return {
      exitCode: errorMessage ? 1 : 0,
      signal: null,
      timedOut: false,
      errorMessage,
      usage: usage.inputTokens > 0 || usage.outputTokens > 0 ? usage : undefined,
      sessionParams: { threadId },
      sessionDisplayId: threadId,
      provider: "deerflow",
      model: model || undefined,
      billingType,
      summary: summary || undefined,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const msg = err instanceof Error ? err.message : String(err);

    if (!isAbort) {
      await onLog("stderr", `[deerflow error] ${msg}\n`);
    }

    return {
      exitCode: isAbort ? null : 1,
      signal: isAbort ? "SIGTERM" : null,
      timedOut: isAbort,
      errorMessage: isAbort ? `Timed out after ${timeoutSec}s` : msg,
      usage: usage.inputTokens > 0 || usage.outputTokens > 0 ? usage : undefined,
      sessionParams: threadId ? { threadId } : undefined,
      sessionDisplayId: threadId || undefined,
      provider: "deerflow",
      model: model || undefined,
      billingType,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
