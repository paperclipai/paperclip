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
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { parseOpenCodeResponse, isOpenCodeSessionNotFound } from "./parse.js";

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

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

  // Build Paperclip env — same wake vars as opencode_local so the remote agent
  // has full context even though we can't set process env vars remotely.
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  // Build prompt following the same pattern as opencode_local:
  // instructions + bootstrap + wake prompt + handoff + rendered template.
  // Since this is a remote adapter, we also inject env vars into the prompt
  // so the agent has API access (PAPERCLIP_API_KEY, etc.).
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const hasExistingSession = asString(runtimeSessionParams.sessionId, "").length > 0;
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const renderedBootstrapPrompt =
    !hasExistingSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: hasExistingSession,
  });
  const shouldUseResumeDeltaPrompt = hasExistingSession && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt
    ? ""
    : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  // Inject env vars into the prompt so the remote agent has API access.
  // Local adapters set these as process env vars; remote adapters must pass them in-band.
  const envEntries = Object.entries(env).filter(
    ([key]) => key.startsWith("PAPERCLIP_"),
  );
  const envSection = envEntries.length > 0
    ? `## Paperclip Environment\n\nThe following environment variables are provided for this run. Use PAPERCLIP_API_KEY to authenticate API calls to PAPERCLIP_API_URL.\n\n${envEntries.map(([k, v]) => `${k}=${v}`).join("\n")}`
    : "";

  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    envSection,
    renderedPrompt,
  ]);

  // Emit invocation metadata
  if (onMeta) {
    await onMeta({
      adapterType: "opencode_remote",
      command: `${url}/session/*/message?directory=${encodeURIComponent(directory)}`,
      commandNotes: [
        `OpenCode remote: ${url}`,
        `Directory: ${directory}`,
        `Provider (configured): ${providerID}`,
        `Model (configured): ${modelID}`,
        `Note: OpenCode may override provider/model via its own config`,
      ],
      env: redactEnvForLogs(env),
      prompt,
      context,
    });
  }

  // Session resolution — check for existing session to resume
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
      // Build a descriptive session title: "AgentName: TEC-29 — Task title"
      const wakePayload = parseObject(context.paperclipWakePayload);
      const wakeIssue = parseObject(wakePayload.issue);
      const issueIdentifier =
        asString(context.issueIdentifier, "") ||
        asString(wakeIssue.identifier, "") ||
        runtime.taskKey ||
        null;
      const issueTitle =
        asString(context.issueTitle, "") ||
        asString(wakeIssue.title, "") ||
        "";
      const agentLabel = agent.name || "Agent";
      const sessionTitle = issueIdentifier
        ? issueTitle
          ? `${agentLabel}: ${issueIdentifier} — ${issueTitle}`
          : `${agentLabel}: ${issueIdentifier}`
        : `${agentLabel}: run ${runId.slice(0, 8)}`;

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
        if (isAbortError(err)) {
          return {
            sessionId: null,
            response: null,
            error: "Session creation timed out",
            timedOut: true,
            raw: "",
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
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

      // OpenCode returns 200 with empty body when the session doesn't exist.
      // Treat this as an error so the retry logic can create a fresh session.
      if (!msgRes.raw.trim()) {
        return {
          sessionId,
          response: null,
          error: `Empty response from OpenCode (session may not exist)`,
          timedOut: false,
          raw: "",
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
      if (isAbortError(err)) {
        return {
          sessionId,
          response: null,
          error: `Message timed out after ${timeoutSec}s`,
          timedOut: true,
          raw: "",
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
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

  // If session resume failed with "not found" or empty response, retry with fresh session.
  // OpenCode may return 200 with empty body for non-existent sessions.
  const shouldRetryWithFreshSession =
    sessionIdToResume &&
    initial.error &&
    !initial.timedOut &&
    (isOpenCodeSessionNotFound(initial.raw) || !initial.raw.trim());
  if (shouldRetryWithFreshSession) {
    await onLog(
      "stderr",
      `[paperclip] OpenCode session "${sessionIdToResume}" not found; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}
