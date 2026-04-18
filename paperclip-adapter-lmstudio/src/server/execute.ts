import { callChatCompletion, streamChatCompletion, ChatMessage } from "./llm-client.js";
import { dispatchTool } from "./tool-executor.js";
import { PAPERCLIP_TOOLS } from "./tools.js";
import type { PaperclipContext } from "./paperclip-tools.js";

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
    "Follow the Paperclip heartbeat procedure:",
    "1. Always checkout an issue before working on it (paperclip_checkout_issue).",
    "2. Read relevant context (paperclip_get_issue_context, paperclip_get_comments).",
    "3. Do the work using the appropriate tools.",
    "4. Update the issue status and add a summary comment (paperclip_update_issue).",
    "5. Return a short text summary when done.",
  ];

  const instructions = asString(context.agentInstructions, "");
  if (instructions) {
    parts.push("", "## Agent Instructions", instructions);
  }

  return parts.join("\n");
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

export async function execute(ctx: ExecutionContext): Promise<ExecutionResult> {
  const config = ctx.config;
  const url = asString(config.url, "http://localhost:1234");
  const model = asString(config.model, "") || asString(config.defaultModel, "");
  const timeoutMs = asNumber(config.timeoutMs, 120000);
  const maxIterations = asNumber(config.maxIterations, 25);

  if (!model) {
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

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(ctx.agent, ctx.context) },
    { role: "user", content: buildUserPrompt(ctx.context) },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalSummary = "";

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let response;
    try {
      response = await callChatCompletion({
        url,
        model,
        messages,
        tools: PAPERCLIP_TOOLS,
        timeoutMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 1,
        signal: null,
        timedOut: msg.includes("timeout") || msg.includes("Abort"),
        errorMessage: `LLM call failed: ${msg}`,
        errorCode: "llm_error",
      };
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
          url,
          model,
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

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        model,
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
      });

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
    model,
    provider: "lmstudio",
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  };
}
