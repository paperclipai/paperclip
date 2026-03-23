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
import { acquire, release } from "./lifecycle.js";

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

async function fetchIssueContext(
  issueId: string,
  authToken: string,
): Promise<{ title: string; description: string } | null> {
  try {
    const res = await fetch(`${PAPERCLIP_BASE_URL}/api/issues/${issueId}`, {
      headers: {
        authorization: `Bearer ${authToken}`,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      title: typeof data.title === "string" ? data.title : "",
      description: typeof data.description === "string" ? data.description : "",
    };
  } catch {
    return null;
  }
}

async function buildUserMessage(ctx: AdapterExecutionContext): Promise<string> {
  const context = parseObject(ctx.context);
  const parts: string[] = [];

  let title = asString(context.issueTitle as unknown, "");
  let description = asString(context.issueBody as unknown, "");

  // If title/body are missing from context, fetch them from the API as a
  // fallback so the LLM always gets meaningful task context.
  if (!title && !description) {
    const issueId = asString(context.issueId as unknown, "");
    const authToken = ctx.authToken ?? "";
    if (issueId && authToken) {
      const fetched = await fetchIssueContext(issueId, authToken);
      if (fetched) {
        title = fetched.title;
        description = fetched.description;
      }
    }
  }

  if (title) parts.push(`# ${title}`);
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent: SSEEvent = {};
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, ""); // strip \r from \r\n
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

  // Ensure DeerFlow containers are running before any API calls
  try {
    await onLog("stdout", "[deerflow] Ensuring containers are running...\n");
    await acquire(deerflowUrl);
    await onLog("stdout", "[deerflow] Containers ready\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[deerflow] Failed to start containers: ${msg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `DeerFlow containers not available: ${msg}`,
      provider: "deerflow",
      model: model || undefined,
      billingType: "api",
    };
  }

  const controller = new AbortController();
  const timer = timeoutSec > 0 ? setTimeout(() => controller.abort(), timeoutSec * 1000) : null;

  let stdout = "";
  let toolCallCount = 0;
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
    const userMessage = await buildUserMessage(ctx);

    // 3. Stream the run
    const runBody = {
      assistant_id: "lead_agent",
      input: {
        messages: [{ role: "human", content: userMessage }],
      },
      config: {
        recursion_limit: recursionLimit,
      },
      // LangGraph 0.6+ context — populates both config.configurable and runtime.context
      context: {
        thread_id: threadId,
        ...(model ? { model_name: model } : {}),
        thinking_enabled: thinkingEnabled,
        subagent_enabled: subagentEnabled,
        ...(skill ? { skill_name: skill } : {}),
        paperclip_api_url: PAPERCLIP_BASE_URL,
        paperclip_company_id: ctx.agent.companyId,
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

    for await (const sse of parseSSE(reader)) {
      if (!sse.data) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(sse.data);
      } catch {
        continue;
      }

      if (sse.event === "messages" || sse.event === "messages-tuple" || sse.event === "messages/partial" || sse.event === "messages/complete") {
        // LangGraph streams messages as [messageData, metadata] tuple.
        // The first element is the message object itself.
        const tuple = parsed as [Record<string, unknown>, ...unknown[]];
        if (!Array.isArray(tuple) || tuple.length < 1) continue;

        const msgData = tuple[0];
        const msgType = asString(msgData.type as unknown, "");

        // Skip middleware-generated messages (e.g. TitleMiddleware, MemoryMiddleware)
        // — only capture content from the main model and tool nodes.
        const metadata = tuple.length > 1 ? (tuple[1] as Record<string, unknown>) : {};
        const nodeName = asString(metadata.langgraph_node as unknown, "");
        const isMiddleware = nodeName.includes("Middleware");

        if (msgType === "AIMessageChunk" || msgType === "AIMessage") {
          const content = asString(msgData.content as unknown, "");
          if (content && !isMiddleware) {
            await onLog("stdout", content);
            stdout = appendWithCap(stdout, content);
            lastAiContent += content;
          }

          // Tool calls in AI message
          const toolCalls = msgData.tool_calls;
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            toolCallCount += toolCalls.length;
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
            await onLog("stderr", `[tool_result] ${truncated}\n`);
          }
        }
      } else if (sse.event === "values") {
        // Full state snapshot — extract artifacts, title, and AI messages.
        const stateData = parsed as Record<string, unknown>;
        const title = asString(stateData.title as unknown, "");
        if (title) {
          await onLog("stdout", `\n[title] ${title}\n`);
        }
        // Extract the last AI message from the values snapshot as a fallback.
        // The streaming messages handler above is preferred; only use values
        // if streaming didn't capture anything (e.g. non-streaming mode).
        if (lastAiContent.trim().length === 0) {
          const msgs = stateData.messages;
          if (Array.isArray(msgs)) {
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i] as Record<string, unknown>;
              if ((m.type === "ai" || m.type === "AIMessage") && typeof m.content === "string" && m.content.trim().length > 0) {
                lastAiContent = (m.content as string).trim();
                await onLog("stdout", lastAiContent);
                stdout = appendWithCap(stdout, lastAiContent);
                break;
              }
            }
          }
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

    // Detect when the LLM failed to produce useful output (e.g. asked for
    // clarification instead of doing the work).  In that case we must NOT
    // auto-complete the issue — the task wasn't actually done.
    const refusalPatterns = [
      /\bneed\s+(more\s+)?(clarification|context|details|information|specifics)\b/i,
      /\bcannot\s+proceed\b/i,
      /\bplease\s+provide\b/i,
      /\bwhat\s+(would|do)\s+you\s+(like|want)\s+me\s+to\b/i,
      /\bunable\s+to\s+(complete|proceed|do)\b/i,
    ];
    const isRefusal = refusalPatterns.some((p) => p.test(stdout));
    if (isRefusal) {
      await onLog("stderr", `[deerflow] LLM response appears to be a refusal/clarification request — not marking issue as done\n`);
      errorMessage = "LLM did not produce actionable output (possible refusal or clarification request)";
    }

    // Also fail if the LLM produced no meaningful AI content at all.
    // Strip known boilerplate lines (checkout, thread, tool_call markers) before checking.
    const strippedStdout = stdout
      .replace(/\[deerflow\][^\n]*/g, "")
      .replace(/\[tool_call\][^\n]*/g, "")
      .replace(/\[tool_result\][^\n]*/g, "")
      .replace(/\[title\][^\n]*/g, "")
      .trim();
    if (!isRefusal && strippedStdout.length < 50) {
      await onLog("stderr", `[deerflow] LLM produced no meaningful output (${strippedStdout.length} chars after stripping boilerplate) — not marking issue as done\n`);
      errorMessage = "LLM produced no meaningful output";
    }

    // Detect acknowledgment-only responses: the LLM says "I'll do X" but made
    // no tool calls and produced minimal content.  This is a planning stub, not
    // actual work.
    if (!errorMessage && toolCallCount === 0 && strippedStdout.length < 500) {
      const ackPatterns = [
        /\b(?:I'll|I will|Let me)\s+(?:conduct|do|perform|break|start|begin|research|investigate|analyze|work on)\b/i,
        /\bLet me break this down\b/i,
        /\bcomprehensive\s+research\b/i,
      ];
      const isAckOnly = ackPatterns.some((p) => p.test(strippedStdout));
      if (isAckOnly) {
        await onLog("stderr", `[deerflow] LLM produced only an acknowledgment (${strippedStdout.length} chars, 0 tool calls) — not marking issue as done\n`);
        errorMessage = "LLM acknowledged task but did not execute (no tool calls, no deliverables)";
      }
    }

    // Final safety net: if no tools were called and output is under 200 chars,
    // the LLM almost certainly didn't do real work regardless of content.
    if (!errorMessage && toolCallCount === 0 && strippedStdout.length < 200) {
      await onLog("stderr", `[deerflow] No tool calls and only ${strippedStdout.length} chars of output — not marking issue as done\n`);
      errorMessage = "LLM produced insufficient output with no tool usage";
    }

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
      billingType: "api",
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
      billingType: "api",
    };
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}
