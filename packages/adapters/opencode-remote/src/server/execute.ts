import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import { parseOpenCodeResponse, isOpenCodeSessionNotFound } from "./parse.js";

interface OpenCodeSessionResponse {
  id: string;
  slug?: string;
  version?: string;
  projectID?: string;
  directory?: string;
  title?: string;
  time?: { created: number; updated: number };
}

interface OpenCodeMessageResponse {
  info: {
    id: string;
    sessionID: string;
    role: string;
    time: { created: number; completed?: number };
    error?: { name: string; data?: Record<string, unknown> };
    modelID?: string;
    providerID?: string;
    cost?: number;
    tokens?: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    finish?: string;
  };
  parts: Array<{
    id: string;
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  // Error response shape
  data?: unknown;
  error?: unknown;
  success?: boolean;
}

async function fetchJson<T>(
  url: string,
  opts: RequestInit & { timeoutMs?: number },
): Promise<{ ok: boolean; status: number; data: T; raw: string }> {
  const controller = new AbortController();
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => controller.abort(), opts.timeoutMs)
      : null;

  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
    });
    const raw = await res.text();
    let data: T;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      data = raw as unknown as T;
    }
    return { ok: res.ok, status: res.status, data, raw };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } =
    ctx;

  const url = asString(config.url, "").replace(/\/+$/, "");
  if (!url) throw new Error("opencode_remote adapter requires a url");

  const directory = asString(config.directory, "");
  if (!directory)
    throw new Error("opencode_remote adapter requires a directory");

  const providerID = asString(config.providerID, "anthropic");
  const modelID = asString(config.model, "claude-sonnet-4-6");
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );

  // Build instructions prefix
  const instructionsFilePath = asString(
    config.instructionsFilePath,
    "",
  ).trim();
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    const cwd = asString(config.cwd, process.cwd());
    const resolvedPath = path.resolve(cwd, instructionsFilePath);
    const instructionsDir = `${path.dirname(resolvedPath)}/`;
    try {
      const contents = await fs.readFile(resolvedPath, "utf8");
      instructionsPrefix =
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${resolvedPath}. ` +
        `Resolve any relative file references from ${instructionsDir}\n\n`;
      await onLog(
        "stderr",
        `[paperclip] Loaded agent instructions file: ${resolvedPath}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${resolvedPath}": ${reason}\n`,
      );
    }
  }

  // Build Paperclip env context for template rendering
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const renderedPrompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });
  const prompt = `${instructionsPrefix}${renderedPrompt}`;

  // Emit invocation metadata
  if (onMeta) {
    await onMeta({
      adapterType: "opencode_remote",
      command: `${url}/session/*/message?directory=${encodeURIComponent(directory)}`,
      commandNotes: [
        `OpenCode remote: ${url}`,
        `Directory: ${directory}`,
        `Provider: ${providerID}`,
        `Model: ${modelID}`,
      ],
      env: redactEnvForLogs(env),
      prompt,
      context,
    });
  }

  // Session resolution — check for existing session to resume
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, "");
  const runtimeSessionDir = asString(runtimeSessionParams.directory, "");
  const canResume =
    runtimeSessionId.length > 0 &&
    (runtimeSessionDir.length === 0 || runtimeSessionDir === directory);

  const runAttempt = async (
    resumeSessionId: string | null,
  ): Promise<{
    sessionId: string | null;
    response: OpenCodeMessageResponse | null;
    error: string | null;
    timedOut: boolean;
    raw: string;
  }> => {
    let sessionId = resumeSessionId;

    // Create a new session if not resuming
    if (!sessionId) {
      const taskKey =
        runtime.taskKey ??
        (typeof context.issueIdentifier === "string"
          ? context.issueIdentifier
          : null);
      const sessionTitle = taskKey
        ? `Paperclip: ${taskKey}`
        : `Paperclip run ${runId.slice(0, 8)}`;

      await onLog(
        "stderr",
        `[paperclip] Creating OpenCode session: ${sessionTitle}\n`,
      );

      try {
        const createRes = await fetchJson<OpenCodeSessionResponse>(
          `${url}/session?directory=${encodeURIComponent(directory)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: sessionTitle }),
            timeoutMs: 30000,
          },
        );

        if (!createRes.ok || !createRes.data?.id) {
          return {
            sessionId: null,
            response: null,
            error: `Failed to create session: HTTP ${createRes.status} — ${createRes.raw.slice(0, 500)}`,
            timedOut: false,
            raw: createRes.raw,
          };
        }

        sessionId = createRes.data.id;
        await onLog(
          "stderr",
          `[paperclip] Created OpenCode session: ${sessionId}\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("AbortError") ||
          msg.includes("abort") ||
          msg.includes("timeout")
        ) {
          return {
            sessionId: null,
            response: null,
            error: "Session creation timed out",
            timedOut: true,
            raw: "",
          };
        }
        return {
          sessionId: null,
          response: null,
          error: `Session creation failed: ${msg}`,
          timedOut: false,
          raw: "",
        };
      }
    } else {
      await onLog(
        "stderr",
        `[paperclip] Resuming OpenCode session: ${sessionId}\n`,
      );
    }

    // Send the message
    await onLog("stderr", `[paperclip] Sending message to session...\n`);

    try {
      const msgRes = await fetchJson<OpenCodeMessageResponse>(
        `${url}/session/${sessionId}/message?directory=${encodeURIComponent(directory)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            parts: [{ type: "text", text: prompt }],
            model: { providerID, modelID },
          }),
          timeoutMs,
        },
      );

      // Stream the raw response to onLog for the run viewer
      await onLog("stdout", msgRes.raw + "\n");

      if (!msgRes.ok) {
        return {
          sessionId,
          response: null,
          error: `Message send failed: HTTP ${msgRes.status} — ${msgRes.raw.slice(0, 500)}`,
          timedOut: false,
          raw: msgRes.raw,
        };
      }

      return {
        sessionId,
        response: msgRes.data,
        error: null,
        timedOut: false,
        raw: msgRes.raw,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("AbortError") ||
        msg.includes("abort") ||
        msg.includes("timeout")
      ) {
        return {
          sessionId,
          response: null,
          error: `Message timed out after ${timeoutSec}s`,
          timedOut: true,
          raw: "",
        };
      }
      return {
        sessionId,
        response: null,
        error: `Message send failed: ${msg}`,
        timedOut: false,
        raw: "",
      };
    }
  };

  const toResult = (
    attempt: Awaited<ReturnType<typeof runAttempt>>,
    clearSession = false,
  ): AdapterExecutionResult => {
    if (attempt.timedOut) {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: attempt.error ?? `Timed out after ${timeoutSec}s`,
        sessionId: attempt.sessionId,
        sessionParams: attempt.sessionId
          ? { sessionId: attempt.sessionId, directory }
          : null,
        clearSession,
      };
    }

    if (attempt.error && !attempt.response) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: attempt.error,
        sessionId: attempt.sessionId,
        sessionParams: attempt.sessionId
          ? { sessionId: attempt.sessionId, directory }
          : null,
        clearSession,
        resultJson: { raw: attempt.raw },
      };
    }

    const parsed = parseOpenCodeResponse(attempt.response);

    const sessionParams = attempt.sessionId
      ? ({
          sessionId: attempt.sessionId,
          directory,
        } as Record<string, unknown>)
      : null;

    const hasError = Boolean(parsed.errorMessage);

    return {
      exitCode: hasError ? 1 : 0,
      signal: null,
      timedOut: false,
      errorMessage: hasError ? parsed.errorMessage : null,
      usage: {
        inputTokens: parsed.usage.inputTokens,
        outputTokens: parsed.usage.outputTokens,
        cachedInputTokens: parsed.usage.cachedInputTokens,
      },
      sessionId: attempt.sessionId,
      sessionParams,
      sessionDisplayId: attempt.sessionId,
      provider: parsed.providerID ?? providerID,
      model: parsed.modelID ?? modelID,
      costUsd: parsed.costUsd,
      resultJson: { raw: attempt.raw },
      summary: parsed.summary,
      clearSession: Boolean(clearSession && !attempt.sessionId),
    };
  };

  // Run the attempt, with session resume retry logic
  const sessionIdToResume = canResume ? runtimeSessionId : null;
  const initial = await runAttempt(sessionIdToResume);

  // If session resume failed with "not found", retry with fresh session
  if (
    sessionIdToResume &&
    initial.error &&
    !initial.timedOut &&
    isOpenCodeSessionNotFound(initial.raw)
  ) {
    await onLog(
      "stderr",
      `[paperclip] OpenCode session "${sessionIdToResume}" not found; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}
