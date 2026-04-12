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
// Paperclip issue interaction
//
// DeerFlow agents are assistants — they may only post comments on issues.
// They MUST NOT call status mutation endpoints (PATCH /issues/:id, reopen,
// interrupt). The senior agent (their manager) reviews the assistant's
// comment and decides the issue's outcome. The server enforces this rule
// in `routes/issues.ts`; this adapter cooperates by only ever calling the
// comment endpoint.
// ---------------------------------------------------------------------------

const PAPERCLIP_BASE_URL = process.env.PAPERCLIP_INTERNAL_URL ?? "http://127.0.0.1:3100";

const DEERFLOW_OUTPUT_TAG = "<!-- deerflow:research -->";

async function postCommentToIssue(
  issueId: string,
  authToken: string,
  runId: string,
  body: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${PAPERCLIP_BASE_URL}/api/issues/${issueId}/comments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        "x-paperclip-run-id": runId,
      },
      // No `reopen`, no `interrupt` — comment-only.
      body: JSON.stringify({ body }),
    });
    return res.ok;
  } catch {
    // Best-effort. The run record still reflects success/failure.
    return false;
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

  const deerflowUrl = asString(
    config.deerflowUrl as unknown,
    "http://deerflow-langgraph:2024",
  );
  const model = asString(config.model as unknown, "");
  const skill = asString(config.skill as unknown, "");
  const thinkingEnabled = asBoolean(config.thinkingEnabled as unknown, false);
  const subagentEnabled = asBoolean(config.subagentEnabled as unknown, true);
  const timeoutSec = asNumber(config.timeoutSec as unknown, 600);
  const recursionLimit = asNumber(config.recursionLimit as unknown, 50);

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
  const taskType = asString(contextObj.taskType as unknown, "");
  const issueLabels = Array.isArray(contextObj.labelNames) ? contextObj.labelNames as string[] : [];

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
  // Dedup stream noise: LangGraph streams AIMessageChunks incrementally, so the
  // same tool call and the same title re-appear in many chunks. We track ids
  // we've already logged to keep the stdout log readable and to keep
  // toolCallCount honest (it's consumed by the "did any tool fire?" check
  // downstream).
  const loggedToolCallIds = new Set<string>();
  let lastLoggedTitle = "";
  const usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
  let summary = "";
  let errorMessage: string | null = null;
  let isTimedOut = false;
  // Hoisted out of the try block so the final comment post (which runs after
  // try/catch/finally) can include any partial AI content we managed to
  // capture before an exception was thrown — e.g. the first few model turns
  // before LangGraph hit its recursion limit and closed the stream.
  let lastAiContent = "";

  try {
    // Note: DeerFlow agents are assistants. They do NOT check out issues —
    // checkout is an exclusive ownership primitive reserved for executors
    // (their manager). The assistant just reads the issue and comments.

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
        ...(taskType ? { task_type: taskType } : {}),
        ...(issueLabels.length > 0 ? { issue_labels: issueLabels } : {}),
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

          // Tool calls in AI message. Dedup by id: LangGraph streams a tool
          // call across several AIMessageChunks (first chunk has the name,
          // subsequent chunks stream args incrementally). Without dedup we
          // log "[tool_call] <name>" once and then 3-5 "[tool_call] unknown"
          // lines per real call, and toolCallCount becomes meaningless.
          const toolCalls = msgData.tool_calls;
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            for (const tc of toolCalls) {
              const tcObj = tc as Record<string, unknown>;
              const name = asString(tcObj.name as unknown, "");
              const id = asString(tcObj.id as unknown, "");
              // Partial chunk with no name → skip; we'll catch this call when
              // the chunk carrying the name arrives.
              if (!name) continue;
              // Stable key: prefer the real id, fall back to name+position for
              // streams that omit ids.
              const key = id || `${name}:${loggedToolCallIds.size}`;
              if (loggedToolCallIds.has(key)) continue;
              loggedToolCallIds.add(key);
              toolCallCount += 1;
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
          const toolName = asString(msgData.name as unknown, "");
          if (content) {
            // Task tool results contain subagent output — show prominently on stdout
            const isTaskResult = toolName === "task" || content.startsWith("[task_");
            if (isTaskResult) {
              const truncated = content.length > 6000 ? content.slice(0, 6000) + "\n..." : content;
              await onLog("stdout", `\n--- Subagent Result ---\n${truncated}\n---\n`);
              stdout = appendWithCap(stdout, truncated);
            } else {
              // Regular tool results (web_search, web_fetch, etc.) — show on stdout too
              const truncated = content.length > 3000 ? content.slice(0, 3000) + "..." : content;
              await onLog("stdout", `\n[${toolName || "tool_result"}] ${truncated}\n`);
              stdout = appendWithCap(stdout, truncated);
            }
          }
        }
      } else if (sse.event === "values") {
        // Full state snapshot — extract artifacts, title, and AI messages.
        const stateData = parsed as Record<string, unknown>;
        // Title is re-emitted on every state snapshot. Only log when it
        // actually changes (first appearance, or an edit by TitleMiddleware).
        const title = asString(stateData.title as unknown, "");
        if (title && title !== lastLoggedTitle) {
          lastLoggedTitle = title;
          await onLog("stdout", `\n[title] ${title}\n`);
        }
        // Extract AI content from the values snapshot as a fallback.
        // The streaming messages handler above is preferred; only use values
        // if streaming didn't capture anything (e.g. non-streaming mode).
        if (lastAiContent.trim().length === 0) {
          const msgs = stateData.messages;
          if (Array.isArray(msgs)) {
            // First pass: look for an AI message with text content
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i] as Record<string, unknown>;
              if ((m.type === "ai" || m.type === "AIMessage") && typeof m.content === "string" && m.content.trim().length > 0) {
                lastAiContent = (m.content as string).trim();
                await onLog("stdout", lastAiContent);
                stdout = appendWithCap(stdout, lastAiContent);
                break;
              }
            }
            // Second pass: if model only made tool calls without synthesizing,
            // concatenate tool results as the output (the research data IS the value).
            if (lastAiContent.trim().length === 0) {
              const toolResults: string[] = [];
              for (const m of msgs) {
                const msg = m as Record<string, unknown>;
                if ((msg.type === "tool" || msg.type === "ToolMessage") && typeof msg.content === "string" && msg.content.trim().length > 50) {
                  toolResults.push(msg.content as string);
                }
              }
              if (toolResults.length > 0) {
                lastAiContent = toolResults.join("\n\n---\n\n").slice(0, 8000);
                await onLog("stdout", `\n[deerflow] Model did not synthesize results — extracting tool output:\n${lastAiContent}`);
                stdout = appendWithCap(stdout, lastAiContent);
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

    // Cap the summary generously. The full LLM output is useful research
    // context for the parent agent, so we avoid over-truncating here; the
    // tighter caps live at the API boundary (the comment endpoint) and in
    // downstream consumers.
    summary = lastAiContent.slice(0, 20000);

    // Detect when the LLM failed to produce useful output (e.g. asked for
    // clarification instead of doing the work).  In that case we must NOT
    // auto-complete the issue — the task wasn't actually done.
    const refusalPatterns = [
      /\bneed\s+(more\s+)?(clarification|context|details|information|specifics)\b/i,
      /\bcannot\s+proceed\b/i,
      /\bplease\s+provide\b/i,
      /\bwhat\s+(would|do)\s+you\s+(like|want)\s+me\s+to\b/i,
      /\bunable\s+to\s+(complete|proceed|do)\b/i,
      // Agent produced a coherent summary but concluded the task cannot be
      // fulfilled (e.g. required file is missing, required service is down).
      // Without this, the agent writes "Summary: not available, not available,
      // not available — the smoke test cannot be completed" and then calls
      // the `done` transition, which is the wrong outcome.
      /\bcannot\s+be\s+(completed|fulfilled|performed|accomplished)\b/i,
      /\btask\s+cannot\s+be\s+(completed|done|fulfilled|executed)\b/i,
      /\brequired\s+(file|resource|service|path|dependency)\s+(?:is\s+|was\s+)?not\s+(present|found|available|accessible)\b/i,
    ];
    // Only match refusal phrases in the tail of stdout — the agent's final
    // assessment. Matching against the whole log false-positives on mid-run
    // "the file was not found, let me check elsewhere" reasoning which the
    // agent then resolves.
    const tailForRefusalCheck = stdout.slice(-2500);
    const isRefusal = refusalPatterns.some((p) => p.test(tailForRefusalCheck));
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

    // End of streaming. Fall through to the unified post-and-return tail
    // below — both the success path and the catch path go through there so
    // that postCommentToIssue is ALWAYS called when we have an issue+token,
    // regardless of whether the run succeeded, refused, or threw mid-stream.
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const msg = err instanceof Error ? err.message : String(err);

    if (isAbort) {
      isTimedOut = true;
      errorMessage = `Timed out after ${timeoutSec}s`;
    } else {
      errorMessage = msg;
      await onLog("stderr", `[deerflow error] ${msg}\n`);
    }

    // Capture any partial AI content that streamed before the exception so
    // the failure comment can include diagnostic context (the model's first
    // few turns of "let me search…" reasoning, etc.). The success path
    // sets `summary` after the SSE loop ends; here we fall back to whatever
    // we managed to stream.
    if (!summary && lastAiContent) {
      summary = lastAiContent.slice(0, 20000);
    }
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }

  // ---------------------------------------------------------------------
  // Unified post-and-return tail.
  //
  // Reached after either:
  //   (a) the SSE stream completed cleanly (with or without errorMessage
  //       set by the refusal/empty/ack guards inside the try block), or
  //   (b) the try block threw and the catch above populated errorMessage
  //       (and isTimedOut, if relevant).
  //
  // Posting the comment here — outside the try/catch/finally — guarantees
  // the manager always sees a comment when the assistant ran, even when
  // LangGraph closes the stream with a hard error like
  // GraphRecursionError. Returning here also gives us a single source of
  // truth for the AdapterExecutionResult shape.
  // ---------------------------------------------------------------------

  if (issueId && authToken) {
    const commentBody = errorMessage
      ? `${DEERFLOW_OUTPUT_TAG}\n## DeerFlow Output (failed)\n\n${errorMessage}${
          summary ? `\n\n---\n${summary}` : ""
        }`
      : `${DEERFLOW_OUTPUT_TAG}\n## DeerFlow Research\n\n${summary || "(no output)"}`;
    const posted = await postCommentToIssue(issueId, authToken, ctx.runId, commentBody);
    if (posted) {
      await onLog("stdout", `\n[deerflow] Posted research comment on issue ${issueId}\n`);
    } else {
      await onLog("stderr", `\n[deerflow] Failed to post research comment on issue ${issueId}\n`);
    }
  }

  return {
    exitCode: errorMessage ? (isTimedOut ? null : 1) : 0,
    signal: isTimedOut ? "SIGTERM" : null,
    timedOut: isTimedOut,
    errorMessage,
    usage: usage.inputTokens > 0 || usage.outputTokens > 0 ? usage : undefined,
    sessionParams: threadId ? { threadId } : undefined,
    sessionDisplayId: threadId || undefined,
    provider: "deerflow",
    model: model || undefined,
    billingType: "api",
    summary: summary || undefined,
  };
}
