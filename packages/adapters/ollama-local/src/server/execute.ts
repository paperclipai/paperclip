import type {
  AdapterAgent,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_OLLAMA_LOCAL_BASE_URL,
  DEFAULT_OLLAMA_LOCAL_MODEL,
} from "../index.js";
import { ensureOllamaModelPulled } from "./prepare.js";

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Resolve the URL of the Paperclip API that this adapter should call back into
 * to post comments. Mirrors the resolution order from buildPaperclipEnv so the
 * adapter and any spawned subprocess agree on which port to hit.
 */
function resolvePaperclipApiUrl(): string {
  const explicit = process.env.PAPERCLIP_RUNTIME_API_URL ?? process.env.PAPERCLIP_API_URL;
  if (explicit && explicit.trim().length > 0) return explicit.replace(/\/$/, "");
  const host = process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost";
  const port = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  // ::1 / 0.0.0.0 / loopback shorthands all fail to resolve as URLs; normalize.
  const safeHost = host === "0.0.0.0" || host === "::" || host === "::1" ? "localhost" : host;
  return `http://${safeHost}:${port}`;
}

interface PaperclipWakeIssueShape {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
}

interface PaperclipWakeCommentShape {
  id?: string;
  body?: string;
  authorAgentName?: string | null;
  authorUserName?: string | null;
  createdAt?: string;
}

/**
 * Build a tight, small-model-friendly prompt out of the wake context. The
 * default `renderPaperclipWakePrompt` produces ~1000 words of "execution
 * contract" boilerplate intended for frontier LLMs; a 7–14B local model
 * gets lost in it and ends up replying with generic acknowledgements
 * ("I'm ready to continue my Paperclip work…"). We extract just the parts
 * a thinking-class agent actually needs to write a useful reply.
 */
function buildLocalModelPrompt(input: {
  agent: AdapterAgent;
  context: Record<string, unknown>;
}): { issueId: string | null; issueIdentifier: string | null; prompt: string } {
  const wake = parseObject(input.context.paperclipWake);
  const issue = parseObject(wake.issue) as Partial<PaperclipWakeIssueShape>;
  const comments = Array.isArray(wake.comments)
    ? (wake.comments as PaperclipWakeCommentShape[])
    : [];
  const reason = typeof wake.reason === "string" ? wake.reason : null;
  const issueId = typeof issue.id === "string" ? issue.id : null;
  const issueIdentifier = typeof issue.identifier === "string" ? issue.identifier : null;
  const issueTitle = typeof issue.title === "string" ? issue.title : null;
  const issueStatus = typeof issue.status === "string" ? issue.status : null;

  const lines: string[] = [];
  if (issueIdentifier && issueTitle) {
    lines.push(`Issue ${issueIdentifier}: ${issueTitle}`);
  } else if (issueTitle) {
    lines.push(`Issue: ${issueTitle}`);
  }
  if (issueStatus) lines.push(`Status: ${issueStatus}`);
  if (reason && reason !== "manual_invoke") lines.push(`Wake reason: ${reason}`);

  if (comments.length > 0) {
    lines.push("");
    lines.push("Recent comments:");
    // Last few comments only; small models lose the plot beyond that.
    const recent = comments.slice(-5);
    for (const c of recent) {
      const author = c.authorAgentName ?? c.authorUserName ?? "user";
      const body = (c.body ?? "").trim();
      if (body.length > 0) {
        lines.push(`- ${author}: ${body.slice(0, 600)}`);
      }
    }
  }

  lines.push("");
  lines.push(
    "Write a concise, helpful reply that addresses the issue. Your reply will be posted as a comment on this issue.",
  );

  return {
    issueId,
    issueIdentifier,
    prompt: lines.join("\n"),
  };
}

async function postReplyAsComment(input: {
  apiUrl: string;
  authToken: string;
  issueId: string;
  body: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ ok: boolean; error?: string }> {
  const url = `${input.apiUrl}/api/issues/${input.issueId}/comments`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.authToken}`,
      },
      body: JSON.stringify({ body: input.body }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      await input.onLog(
        "stderr",
        `[paperclip] Failed to post comment: HTTP ${res.status} ${errText.slice(0, 300)}\n`,
      );
      return { ok: false, error: `HTTP ${res.status}` };
    }
    await input.onLog("stdout", `[paperclip] Posted reply as comment on issue ${input.issueId}.\n`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await input.onLog("stderr", `[paperclip] Comment POST threw: ${message}\n`);
    return { ok: false, error: message };
  }
}

/**
 * After posting the reply as a comment, transition the issue out of
 * `in_progress` so Paperclip's run-liveness watchdog stops re-waking the
 * agent. Without this, every Q&A reply lives forever in the `in_progress`
 * column and `wakeReason: issue_continuation_needed` fires every ~30s.
 *
 * `in_review` is the right default for thinking-class agents — "I answered,
 * a human can review and either close or follow up." Users who want
 * different behavior (e.g. auto-close to "done", or no transition at all)
 * can override via the `completionStatus` adapter config field.
 */
async function transitionIssueStatus(input: {
  apiUrl: string;
  authToken: string;
  issueId: string;
  status: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ ok: boolean; error?: string }> {
  const url = `${input.apiUrl}/api/issues/${input.issueId}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.authToken}`,
      },
      body: JSON.stringify({ status: input.status }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      await input.onLog(
        "stderr",
        `[paperclip] Failed to set issue status to ${input.status}: HTTP ${res.status} ${errText.slice(0, 300)}\n`,
      );
      return { ok: false, error: `HTTP ${res.status}` };
    }
    await input.onLog(
      "stdout",
      `[paperclip] Marked issue ${input.issueId} as "${input.status}".\n`,
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await input.onLog("stderr", `[paperclip] Issue status PATCH threw: ${message}\n`);
    return { ok: false, error: message };
  }
}

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function defaultSystemPromptForAgent(agent: AdapterAgent): string {
  const capabilities =
    typeof agent.adapterConfig === "object" && agent.adapterConfig !== null
      ? (agent.adapterConfig as Record<string, unknown>).capabilities
      : null;
  // Capabilities text on the agent itself takes priority, then the row's
  // capabilities column (if surfaced via the agent record), then a generic
  // fallback. The wake prompt itself carries the actual task.
  const fromConfig = typeof capabilities === "string" ? capabilities.trim() : "";
  if (fromConfig) return fromConfig;
  return (
    `You are ${agent.name}, an agent in the Paperclip system. ` +
    `Read the wake prompt below carefully and respond with a clear, concise reply ` +
    `that fulfills the request. Do not propose code edits unless explicitly asked. ` +
    `When the wake prompt mentions a Paperclip issue, your reply should be suitable ` +
    `for posting as a comment on that issue.`
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, authToken } = ctx;
  const cfg = parseObject(config);
  const baseUrl = asString(cfg.ollamaBaseUrl, DEFAULT_OLLAMA_LOCAL_BASE_URL).replace(/\/$/, "");
  const model = asString(cfg.model, DEFAULT_OLLAMA_LOCAL_MODEL);
  const temperature = asNumber(cfg.temperature, NaN);
  const numPredict = asNumber(cfg.numPredict, 0);
  const timeoutSec = asNumber(cfg.timeoutSec, 600);
  const explicitSystem = asString(cfg.systemPrompt, "");
  const systemPrompt = explicitSystem.length > 0 ? explicitSystem : defaultSystemPromptForAgent(agent);

  // Build a small-model-friendly prompt out of the wake context. The standard
  // renderPaperclipWakePrompt is too dense for 7B–14B local models — they
  // bury themselves in the "execution contract" boilerplate and reply with
  // generic acknowledgements instead of actually answering the issue.
  const { issueId, issueIdentifier, prompt: userPrompt } = buildLocalModelPrompt({
    agent,
    context,
  });
  void runId;

  await onLog(
    "stdout",
    `[paperclip] ollama_local invoking ${baseUrl}/api/chat with model "${model}".\n`,
  );

  // Auto-pull the model if missing. Streams progress through onLog
  // ("[paperclip ollama] downloading 47%…").
  try {
    await ensureOllamaModelPulled({ model, baseUrl, onLog });
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "ollama_unreachable",
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  }

  const messages: OllamaChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const requestBody: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };
  const options: Record<string, unknown> = {};
  if (Number.isFinite(temperature)) options.temperature = temperature;
  if (numPredict > 0) options.num_predict = numPredict;
  if (Object.keys(options).length > 0) requestBody.options = options;

  const startedAt = Date.now();
  let res: Response;
  const controller = new AbortController();
  const timeoutHandle = timeoutSec > 0
    ? setTimeout(() => controller.abort(), timeoutSec * 1000)
    : null;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: controller.signal.aborted,
      errorMessage:
        err instanceof Error
          ? err.name === "AbortError"
            ? `Ollama request timed out after ${timeoutSec}s`
            : err.message
          : String(err),
      errorCode: "ollama_unreachable",
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const elapsedMs = Date.now() - startedAt;
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    await onLog("stderr", `[paperclip] Ollama responded HTTP ${res.status}: ${errText.slice(0, 500)}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Ollama returned HTTP ${res.status}: ${errText.slice(0, 200)}`,
      errorCode: res.status === 404 ? "ollama_model_not_pulled" : "ollama_request_failed",
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  }

  let body: OllamaChatResponse;
  try {
    body = (await res.json()) as OllamaChatResponse;
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to parse Ollama response: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "ollama_response_parse_error",
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  }

  if (body.error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: body.error,
      errorCode: "ollama_response_error",
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  }

  const replyContent = body.message?.content ?? "";
  await onLog("stdout", replyContent + "\n");

  // Post the reply as a comment on the wake issue. This is the *whole point*
  // of ollama_local — the model thinks, the adapter writes the answer to the
  // issue thread, the issue advances. Without this callback, replies vanish
  // into AdapterExecutionResult.summary and Paperclip's liveness watchdog
  // wakes the agent again ~30s later thinking nothing happened, looping
  // forever. Skip when:
  //   - There's no issue context (e.g. a pure manual heartbeat).
  //   - There's no auth token (shouldn't happen — heartbeat runtime always
  //     supplies one — but fail soft rather than crash).
  //   - The reply is empty.
  let commentPosted = false;
  let commentError: string | null = null;
  let statusTransitioned = false;
  let statusError: string | null = null;
  // Default to `in_review` — agent answered, human reviews. Override per-agent
  // via adapterConfig.completionStatus (allowed values: any ISSUE_STATUSES
  // member, plus "none" to skip the transition entirely).
  const completionStatus = asString(cfg.completionStatus, "in_review");
  if (issueId && replyContent.trim().length > 0) {
    if (authToken) {
      const apiUrl = resolvePaperclipApiUrl();
      const commentResult = await postReplyAsComment({
        apiUrl,
        authToken,
        issueId,
        body: replyContent.trim(),
        onLog,
      });
      commentPosted = commentResult.ok;
      commentError = commentResult.ok ? null : commentResult.error ?? "unknown";

      if (commentPosted && completionStatus && completionStatus !== "none") {
        const statusResult = await transitionIssueStatus({
          apiUrl,
          authToken,
          issueId,
          status: completionStatus,
          onLog,
        });
        statusTransitioned = statusResult.ok;
        statusError = statusResult.ok ? null : statusResult.error ?? "unknown";
      }
    } else {
      await onLog(
        "stderr",
        `[paperclip] No authToken supplied to ollama_local; cannot post comment on issue ${issueIdentifier ?? issueId}. Reply remained as run summary only.\n`,
      );
      commentError = "missing_auth_token";
    }
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    errorCode: null,
    usage:
      body.prompt_eval_count != null || body.eval_count != null
        ? {
            inputTokens: body.prompt_eval_count ?? 0,
            outputTokens: body.eval_count ?? 0,
          }
        : undefined,
    provider: "ollama",
    biller: "local",
    model: body.model ?? model,
    billingType: "subscription",
    costUsd: 0,
    summary: replyContent.length > 0 ? replyContent.slice(0, 4000) : null,
    resultJson: {
      ollamaBaseUrl: baseUrl,
      doneReason: body.done_reason ?? null,
      totalDurationMs: body.total_duration != null ? body.total_duration / 1_000_000 : null,
      requestElapsedMs: elapsedMs,
      issueId: issueId ?? null,
      issueIdentifier: issueIdentifier ?? null,
      commentPosted,
      commentError,
      completionStatus: completionStatus ?? null,
      statusTransitioned,
      statusError,
    },
  };
}
