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
import { readDesiredSkillContent } from "./skills.js";

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

async function resetIssueForRetry(
  issueId: string,
  runId: string,
  authToken: string,
  retryNum: number,
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
        status: "todo",
        comment: `<!-- deerflow-retry:${retryNum} --> DeerFlow auto-retry: non-substantive response, resetting to todo.`,
      }),
    });
  } catch {
    // Best-effort
  }
}

async function blockIssue(
  issueId: string,
  runId: string,
  authToken: string,
  reason: string,
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
        status: "blocked",
        comment: `## DeerFlow Adapter Failed\n\n${reason}`,
      }),
    });
  } catch {
    // Best-effort
  }
}

async function getDeerflowRetryCount(
  issueId: string,
  authToken: string,
): Promise<number> {
  try {
    const res = await fetch(`${PAPERCLIP_BASE_URL}/api/issues/${issueId}/comments`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return 0;
    const comments = (await res.json()) as Array<{ body?: string }>;
    let maxRetry = 0;
    for (const c of comments) {
      const match = c.body?.match(/<!-- deerflow-retry:(\d+) -->/);
      if (match) {
        maxRetry = Math.max(maxRetry, parseInt(match[1], 10));
      }
    }
    return maxRetry;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hydrateIssueContext(
  context: Record<string, unknown>,
  authToken: string,
): Promise<void> {
  const issueId = asString(context.issueId as unknown, "");
  if (!issueId || !authToken) return;
  // Already hydrated?
  if (asString(context.issueTitle as unknown, "")) return;

  try {
    const res = await fetch(`${PAPERCLIP_BASE_URL}/api/issues/${issueId}/heartbeat-context`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, unknown>;
    const issue = data.issue as Record<string, unknown> | undefined;
    if (issue) {
      if (issue.title) context.issueTitle = issue.title;
      if (issue.description) context.issueBody = issue.description;
    }
    if (data.comments) context.comments = data.comments;
    if (data.goalAncestry) context.goalAncestry = data.goalAncestry;
  } catch {
    // Best-effort — continue without issue details
  }
}

function buildUserMessage(ctx: AdapterExecutionContext, hydratedContext?: Record<string, unknown>): string {
  const context = hydratedContext ?? parseObject(ctx.context);
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

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
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
    for (const rawLine of buffer.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
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

    // 2. Hydrate issue context if needed (issueId present but title/body missing)
    const hydratedContext = parseObject(ctx.context);
    await hydrateIssueContext(hydratedContext, authToken);

    // 2b. Build the message
    const userMessage = buildUserMessage(ctx, hydratedContext);

    // 2a. Load desired skill content for injection into the DeerFlow context.
    //     readDesiredSkillContent reads from config.paperclipRuntimeSkills (set by
    //     Paperclip server) so no filesystem dependency at runtime.
    const skillsContent = await readDesiredSkillContent(config);

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
        // Inject all Paperclip-managed skills selected for this agent.
        // The DeerFlow Python side reads these via the LangGraph run context.
        // skill_names = hints for the Python skill registry
        // skills_content = pre-loaded SKILL.md content (no filesystem lookup needed)
        ...(skillsContent.length > 0 ? {
          skill_names: skillsContent.map((s) => s.name),
          skills_content: skillsContent,
        } : {}),
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

      if (sse.event === "messages-tuple" || sse.event === "messages/partial" || sse.event === "messages") {
        // LangGraph streams messages in two possible formats:
        // 1. messages-tuple mode: ["AIMessageChunk", {content, ...}]
        // 2. messages mode: [{content, type: "AIMessageChunk", ...}, {metadata}]
        const arr = parsed as unknown[];
        if (!Array.isArray(arr) || arr.length < 1) continue;

        let msgType: string;
        let msgData: Record<string, unknown>;

        if (typeof arr[0] === "string") {
          // Tuple format: [type, data]
          msgType = arr[0];
          msgData = (arr[1] ?? {}) as Record<string, unknown>;
        } else if (typeof arr[0] === "object" && arr[0] !== null) {
          // Object format: [messageObject, metadataObject]
          msgData = arr[0] as Record<string, unknown>;
          msgType = asString(msgData.type as unknown, "");
        } else {
          continue;
        }

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

    // Check if the response is substantive (not just metadata/empty)
    const isSubstantive = lastAiContent.length > 200; // ~50 tokens at 4 chars/token

    if (!errorMessage && issueId && authToken) {
      if (isSubstantive) {
        await completeIssue(issueId, ctx.runId, authToken, summary);
        await onLog("stdout", `\n[deerflow] Marked issue ${issueId} as done\n`);
      } else {
        // Non-substantive response — retry by resetting to todo
        const retryCount = await getDeerflowRetryCount(issueId, authToken);
        if (retryCount < 2) {
          await resetIssueForRetry(issueId, ctx.runId, authToken, retryCount + 1);
          await onLog("stderr", `\n[deerflow] Non-substantive response (${lastAiContent.length} chars). Retry ${retryCount + 1}/2\n`);
          errorMessage = `Non-substantive response, resetting for retry ${retryCount + 1}/2`;
        } else {
          await blockIssue(issueId, ctx.runId, authToken,
            "DeerFlow adapter failed to produce substantive output after 2 retries.");
          await onLog("stderr", `\n[deerflow] Retries exhausted. Blocked issue ${issueId}\n`);
          errorMessage = "Retries exhausted — blocked for human review";
        }
      }
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
