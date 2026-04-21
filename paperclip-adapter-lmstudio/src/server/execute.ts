import { readFile } from "node:fs/promises";
import {
  callChatCompletion,
  streamChatCompletion,
  ChatMessage,
  LlmClientError,
} from "./llm-client.js";
import { resolvePrimaryOrFallback, type Endpoint } from "./endpoint-resolver.js";
import { dispatchTool } from "./tool-executor.js";
import { PAPERCLIP_TOOLS } from "./tools.js";
import { executePaperclipTool, type PaperclipContext } from "./paperclip-tools.js";

interface ExecutionContext {
  runId: string;
  agent: {
    id: string;
    companyId: string;
    name: string;
    adapterType: string | null;
    adapterConfig: unknown;
  };
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  runtime: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    taskKey: string | null;
  };
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  authToken?: string;
}

interface ExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  model?: string | null;
  provider?: string | null;
  summary?: string | null;
  usage?: { inputTokens: number; outputTokens: number };
}

function asString(val: unknown, fallback: string): string {
  return typeof val === "string" ? val : fallback;
}

function asNumber(val: unknown, fallback: number): number {
  return typeof val === "number" ? val : fallback;
}

function buildSystemPrompt(agent: ExecutionContext["agent"], context: Record<string, unknown>): string {
  const parts: string[] = [
    `You are ${agent.name}, a Paperclip AI agent.`,
    `Your agent ID is ${agent.id}. Your company ID is ${agent.companyId}.`,
    "",
    "You have access to tools in three categories:",
    "- Paperclip API: manage issues, comments, subtasks (paperclip_*)",
    "- File System: read, write, search files (fs_*)",
    "- Shell & Git: execute commands, git operations (shell_exec, git_*)",
    "",
    "## MANDATORY Heartbeat Procedure",
    "",
    "You MUST follow these steps in order for EVERY task:",
    "",
    "1. **Checkout the issue** — call `paperclip_checkout_issue` with the issueId.",
    "2. **Understand the task** — call `paperclip_get_issue_context` to see the full description and history.",
    "3. **Do the work** — use filesystem/shell/git tools as needed.",
    "4. **CRITICAL: Close the loop** — call `paperclip_update_issue` with EXACTLY these parameters:",
    '   - `status: "done"` (or `"blocked"` if you cannot complete, `"in_review"` if awaiting human approval)',
    "   - `comment`: a short markdown summary of what you did (what was accomplished, any files created, any blockers)",
    "",
    "## Rules that are NEVER optional",
    "",
    "- Before you return a final text answer, you MUST have called `paperclip_update_issue` with a final status.",
    '- If you skip step 4, the task is considered FAILED regardless of what work you did. The issue will remain stuck in `in_progress` and Paperclip will flag it as a stranded run.',
    '- Do not give a final text reply until AFTER `paperclip_update_issue` has been called successfully.',
    "- If a tool call returned an error, address the error (retry with corrected parameters or mark the issue `blocked` with an explanation). Do not silently ignore errors.",
    "- If you are unsure of the issueId, call `paperclip_get_inbox` first to find your assigned tasks.",
    "",
    "## Final answer format",
    "",
    "After `paperclip_update_issue` succeeds, return ONE short sentence confirming the status update, e.g.:",
    '"Task WHI-14 marked as done. File whitestag-agenten.md created with 6 C-level role descriptions."',
  ];

  const instructions = asString(context.agentInstructions, "");
  if (instructions) {
    parts.push("", "## Agent Instructions", instructions);
  }

  const fileInstructions = asString(context.agentInstructionsFromFile, "");
  if (fileInstructions) {
    parts.push("", "## Agent Persona", fileInstructions);
  }

  return parts.join("\n");
}

async function loadInstructionsFromFile(
  config: Record<string, unknown>,
  onLog: ExecutionContext["onLog"],
): Promise<string> {
  const path = asString(config.instructionsFilePath, "");
  if (!path) return "";

  try {
    return await readFile(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog(
      "stderr",
      `[lmstudio-adapter] Could not read instructionsFilePath=${path}: ${msg}\n`,
    );
    return "";
  }
}

function buildUserPrompt(context: Record<string, unknown>): string {
  const parts: string[] = [];

  const wake = context.paperclipWake as Record<string, unknown> | undefined;
  if (wake) {
    const reason = asString(wake.reason, "unknown");
    const issue = wake.issue as Record<string, unknown> | undefined;
    const issueId = asString(issue?.identifier, asString(issue?.id, "unknown"));
    const issueTitle = asString(issue?.title, "");
    const issueDescription = asString(issue?.description, "");

    parts.push("## Paperclip Wake");
    parts.push(`- reason: ${reason}`);
    parts.push(`- issue: ${issueId}${issueTitle ? ` — ${issueTitle}` : ""}`);
    if (issueDescription) parts.push(`\n### Description\n\n${issueDescription}`);

    const comments = wake.comments as Array<Record<string, unknown>> | undefined;
    if (comments && comments.length > 0) {
      parts.push("\n### Recent Comments\n");
      for (const c of comments) {
        const author = asString(c.authorAgentName, asString(c.authorUserId, "unknown"));
        parts.push(`**${author}:** ${asString(c.body, "")}\n`);
      }
    }
  }

  const promptTemplate = asString(context.renderedPromptTemplate, "");
  if (promptTemplate) parts.push(promptTemplate);

  return parts.join("\n") || "Continue with your current task.";
}

async function logEvent(
  onLog: ExecutionContext["onLog"],
  event: Record<string, unknown>,
): Promise<void> {
  await onLog("stdout", JSON.stringify(event) + "\n");
}

interface PostRunGuardParams {
  checkedOutIssues: Set<string>;
  updatedIssues: Set<string>;
  finalSummary: string;
  paperclipCtx: PaperclipContext;
  onLog: ExecutionContext["onLog"];
}

/**
 * Ensures every issue the LLM checked out received a terminal status update.
 *
 * Small local LLMs sometimes complete the work and add a comment but forget
 * to call paperclip_update_issue with a terminal status, leaving the issue
 * stuck in_progress. This guard catches that and makes the final call on the
 * LLM's behalf with status="blocked" so a human is prompted to review.
 */
async function runPostRunGuard(params: PostRunGuardParams): Promise<void> {
  const { checkedOutIssues, updatedIssues, finalSummary, paperclipCtx, onLog } = params;

  const unclosed = Array.from(checkedOutIssues).filter((id) => !updatedIssues.has(id));
  if (unclosed.length === 0) return;

  for (const issueId of unclosed) {
    const comment = [
      "**Adapter post-run guard triggered:**",
      "",
      "The LLM finished its heartbeat without calling `paperclip_update_issue` with a terminal status.",
      "This adapter has auto-closed the issue as `blocked` so it does not stay stuck in `in_progress`.",
      "",
      "Please review the preceding comments and tool activity to decide whether the work is actually complete.",
      "",
      finalSummary ? `**LLM final message:** ${finalSummary.slice(0, 500)}` : "",
    ].filter(Boolean).join("\n");

    await logEvent(onLog, {
      kind: "system",
      text: `Post-run guard: auto-closing ${issueId} as blocked (LLM did not update status).`,
    });

    const result = await executePaperclipTool(
      "paperclip_update_issue",
      { issueId, status: "blocked", comment },
      paperclipCtx,
    );

    await logEvent(onLog, {
      kind: "tool_result",
      toolUseId: "post-run-guard",
      toolName: "paperclip_update_issue",
      content: result.content,
      isError: result.isError,
    });
  }
}

export async function execute(ctx: ExecutionContext): Promise<ExecutionResult> {
  const config = ctx.config;
  const primaryUrl = asString(config.url, "http://localhost:1234");
  const primaryModel = asString(config.model, "") || asString(config.defaultModel, "");
  const fallbackUrl = asString(config.fallbackUrl, "");
  const fallbackModel = asString(config.fallbackModel, "");
  const probeTimeoutMs = asNumber(config.probeTimeoutMs, 2000);
  const timeoutMs = asNumber(config.timeoutMs, 120000);
  const maxIterations = asNumber(config.maxIterations, 25);
  const maxRunSeconds = asNumber(config.maxRunSeconds, 300);
  const runDeadlineMs = Date.now() + maxRunSeconds * 1000;

  // Parse comma-separated list of additional paths the agent is allowed to write to.
  // Useful for pointing at an Obsidian vault on an external volume.
  const allowedWriteRoots = asString(config.allowedWriteRoots, "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (!primaryModel) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "No model configured. Set 'defaultModel' in adapter config.",
      errorCode: "no_model",
    };
  }

  const paperclipApiUrl = asString(ctx.context.paperclipApiUrl, "http://localhost:3100");
  const cwd = asString(ctx.context.cwd, asString(ctx.config.cwd, process.cwd()));

  const paperclipCtx: PaperclipContext = {
    apiUrl: paperclipApiUrl,
    authToken: ctx.authToken ?? "",
    runId: ctx.runId,
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
  };

  // Probe + Fallback-Entscheidung für diesen Heartbeat
  const resolve = await resolvePrimaryOrFallback({
    primaryUrl,
    primaryModel,
    fallbackUrl,
    fallbackModel,
    probeTimeoutMs,
  });

  if (!resolve.ok) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: resolve.errorMessage,
      errorCode: "llm_unreachable",
    };
  }

  let currentEndpoint: Endpoint = resolve.endpoint;
  let onFallback = resolve.usingFallback;

  if (onFallback) {
    await logEvent(ctx.onLog, {
      kind: "system",
      text:
        `⚠️ Primary LLM nicht erreichbar (${primaryUrl}).\n` +
        `Fallback aktiv: ${currentEndpoint.url} / ${currentEndpoint.model}\n` +
        `Grund: ${resolve.primaryFailureReason ?? "unbekannt"}`,
    });
  }

  // Try a failover on a typed LlmClientError. Returns true if we switched,
  // false if no fallback is available or error kind isn't a failover trigger.
  // Note: we do NOT re-probe the fallback here. Probing is the entry-gate
  // decision at heartbeat start; mid-call failover simply retries on the
  // fallback and will fail cleanly if the fallback is also down.
  async function maybeSwitchToFallback(err: unknown, context: string): Promise<boolean> {
    if (onFallback) return false;
    if (!fallbackUrl) return false;
    if (!(err instanceof LlmClientError)) return false;
    if (err.kind !== "network" && err.kind !== "model" && err.kind !== "timeout") return false;

    currentEndpoint = { url: fallbackUrl, model: fallbackModel || primaryModel };
    onFallback = true;

    await logEvent(ctx.onLog, {
      kind: "system",
      text:
        `⚠️ Primary LLM Fehler während ${context} (${primaryUrl}).\n` +
        `Fallback aktiv: ${currentEndpoint.url} / ${currentEndpoint.model}\n` +
        `Grund: ${err.kind} — ${err.message}`,
    });

    return true;
  }

  const fileInstructions = await loadInstructionsFromFile(config, ctx.onLog);
  const systemPromptContext = fileInstructions
    ? { ...ctx.context, agentInstructionsFromFile: fileInstructions }
    : ctx.context;

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(ctx.agent, systemPromptContext) },
    { role: "user", content: buildUserPrompt(ctx.context) },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalSummary = "";

  // Post-run guard: track checked-out issues and their final status updates
  const checkedOutIssues = new Set<string>();
  const updatedIssues = new Set<string>();
  const TERMINAL_STATUSES = new Set(["done", "blocked", "cancelled", "in_review"]);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (Date.now() > runDeadlineMs) {
      await runPostRunGuard({
        checkedOutIssues,
        updatedIssues,
        finalSummary: `Run deadline of ${maxRunSeconds}s exceeded after ${iteration} iterations.`,
        paperclipCtx,
        onLog: ctx.onLog,
      });
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorMessage: `Run deadline exceeded: wallclock budget of ${maxRunSeconds}s reached after ${iteration} iteration(s). Kill-switch to prevent runaway LLM calls.`,
        errorCode: "run_deadline_exceeded",
        model: currentEndpoint.model,
        provider: "lmstudio",
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      };
    }

    let response;
    try {
      response = await callChatCompletion({
        url: currentEndpoint.url,
        model: currentEndpoint.model,
        messages,
        tools: PAPERCLIP_TOOLS,
        timeoutMs,
      });
    } catch (err) {
      const switched = await maybeSwitchToFallback(err, "chat completion");
      if (switched) {
        try {
          response = await callChatCompletion({
            url: currentEndpoint.url,
            model: currentEndpoint.model,
            messages,
            tools: PAPERCLIP_TOOLS,
            timeoutMs,
          });
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          return {
            exitCode: 1,
            signal: null,
            timedOut: err2 instanceof LlmClientError && err2.kind === "timeout",
            errorMessage: `LLM call failed on fallback: ${msg2}`,
            errorCode: "llm_error",
          };
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          exitCode: 1,
          signal: null,
          timedOut: err instanceof LlmClientError && err.kind === "timeout",
          errorMessage: `LLM call failed: ${msg}`,
          errorCode: "llm_error",
        };
      }
    }

    if (response.usage) {
      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;
    }

    const msg = response.message;
    messages.push(msg as ChatMessage);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Final text answer — stream it by asking LLM to repeat it
      try {
        finalSummary = await streamChatCompletion({
          url: currentEndpoint.url,
          model: currentEndpoint.model,
          messages: [
            ...messages.slice(0, -1),
            { role: "user", content: "Repeat your previous final answer to me verbatim." },
          ],
          timeoutMs,
          onToken: async (token) => {
            await ctx.onLog("stdout", token);
          },
        });
      } catch {
        // Fallback: use the non-streamed content
        finalSummary = msg.content ?? "";
        if (finalSummary) {
          await ctx.onLog("stdout", finalSummary);
        }
      }

      // Post-run guard: ensure every checked-out issue got a terminal status update
      await runPostRunGuard({
        checkedOutIssues,
        updatedIssues,
        finalSummary,
        paperclipCtx,
        onLog: ctx.onLog,
      });

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        model: currentEndpoint.model,
        provider: "lmstudio",
        summary: finalSummary.slice(0, 500),
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      };
    }

    // Execute tool calls
    for (const toolCall of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      await logEvent(ctx.onLog, {
        kind: "tool_call",
        name: toolCall.function.name,
        input: args,
        toolUseId: toolCall.id,
      });

      const result = await dispatchTool({
        name: toolCall.function.name,
        args,
        cwd,
        paperclipCtx,
        allowedWriteRoots,
      });

      // Track checkout and terminal-status updates for the post-run guard
      if (!result.isError) {
        if (toolCall.function.name === "paperclip_checkout_issue") {
          const issueId = typeof args.issueId === "string" ? args.issueId : "";
          if (issueId) checkedOutIssues.add(issueId);
        } else if (toolCall.function.name === "paperclip_update_issue") {
          const issueId = typeof args.issueId === "string" ? args.issueId : "";
          const status = typeof args.status === "string" ? args.status : "";
          if (issueId && TERMINAL_STATUSES.has(status)) {
            updatedIssues.add(issueId);
          }
        }
      }

      await logEvent(ctx.onLog, {
        kind: "tool_result",
        toolUseId: toolCall.id,
        toolName: toolCall.function.name,
        content: result.content,
        isError: result.isError,
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: result.isError ? `Error: ${result.content}` : result.content,
      });
    }
  }

  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: `Max iterations (${maxIterations}) reached without final answer`,
    errorCode: "max_iterations",
    model: currentEndpoint.model,
    provider: "lmstudio",
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  };
}
