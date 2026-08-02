import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  asNumber,
  asString,
  buildPaperclipEnv,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  renderTemplate,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_AGENTSKY_API_BASE_URL,
  DEFAULT_AGENTSKY_HARNESS,
  AGENTSKY_MODELS,
  defaultAgentskyModel,
  isAgentskyHarness,
  isAgentskyModelCompatible,
  AGENTSKY_HARNESSES,
} from "../models.js";
import { AgentskyApiError, createAgentskyClient, type AgentskyClient, type AgentskyEventEnvelope } from "./agentsky-api.js";
import { normalizeAgentskySession, type AgentskyCloudSession } from "./session.js";

const POLL_INTERVAL_MS = 1500;
const EVENTS_PAGE_LIMIT = 200;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const ERROR_EVENT_GRACE_MS = 60_000;

type AgentskyCloudStdoutEvent =
  | { type: "agentsky_cloud.init"; sessionId: string; agentSlug: string; harness: string; model: string }
  | { type: "agentsky_cloud.status"; status: string; message?: string }
  | { type: "agentsky_cloud.message"; event: AgentskyEventEnvelope }
  | {
      type: "agentsky_cloud.result";
      status: string;
      result?: string;
      model?: string;
      durationMs?: number;
      error?: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringEnvMap(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      env[key] = entry;
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (rec.type === "plain" && typeof rec.value === "string") env[key] = rec.value;
    }
  }
  return env;
}

function trimNullable(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function eventLine(event: AgentskyCloudStdoutEvent): string {
  return `${JSON.stringify(event)}\n`;
}

async function emitStatus(onLog: AdapterExecutionContext["onLog"], status: string, message?: string) {
  await onLog("stdout", eventLine({ type: "agentsky_cloud.status", status, ...(message ? { message } : {}) }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A deterministic-but-unique AgentSky agent name derived from the Paperclip agent. */
function agentskyAgentName(paperclipAgentName: string): string {
  const base = paperclipAgentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "agent";
  return `paperclip-${base}-${Date.now().toString(36)}`;
}

function buildPaperclipRuntimeValues(ctx: AdapterExecutionContext): Record<string, string> {
  const { runId, agent, context } = ctx;
  const values: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    PAPERCLIP_RUN_ID: runId,
  };
  // The AgentSky message plane has no env-injection surface, so these are
  // rendered into the prompt. Credentials never belong there: the Paperclip
  // run token is not minted for this adapter (supportsLocalAgentJwt: false)
  // and the AgentSky token is stripped defensively.
  delete values.PAPERCLIP_API_KEY;
  delete values.AGENTSKY_API_TOKEN;

  const wakeTaskId = trimNullable(context.taskId) ?? trimNullable(context.issueId);
  const wakeReason = trimNullable(context.wakeReason);
  const wakeCommentId = trimNullable(context.wakeCommentId) ?? trimNullable(context.commentId);
  const approvalId = trimNullable(context.approvalId);
  const approvalStatus = trimNullable(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) values.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) values.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) values.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) values.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) values.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) values.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) values.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (issueWorkMode) values.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  return values;
}

function renderPaperclipRuntimeNote(values: Record<string, string>): string {
  const keys = Object.keys(values)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (keys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    "You are driven by a Paperclip orchestrator. The following runtime values apply to this wake",
    "(they are NOT set as environment variables in your shell):",
    ...keys.map((key) => `${key}=${values[key]}`),
    "Your final message in this turn is returned to Paperclip as this run's report.",
  ].join("\n");
}

async function buildInstructionsPrefix(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<{ prefix: string; notes: string[]; chars: number }> {
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  if (!instructionsFilePath) {
    return { prefix: "", notes: [], chars: 0 };
  }

  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    const prefix = `${contents.trim()}\n\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsDir}.\n`;
    return {
      prefix,
      chars: prefix.length,
      notes: [
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
      ],
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog(
      "stderr",
      `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
    );
    return {
      prefix: "",
      chars: 0,
      notes: [
        `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      ],
    };
  }
}

function sessionMatches(
  session: AgentskyCloudSession | null,
  resolved: { agentSlugConfig: string | null; harness: string; model: string; apiBaseUrl: string },
): boolean {
  if (!session) return false;
  if ((session.apiBaseUrl ?? DEFAULT_AGENTSKY_API_BASE_URL) !== resolved.apiBaseUrl) return false;
  if (resolved.agentSlugConfig) {
    return session.attached === true && session.agentSlug === resolved.agentSlugConfig;
  }
  return session.attached !== true && session.harness === resolved.harness && session.model === resolved.model;
}

type FailureOverrides = Partial<AdapterExecutionResult> & { errorMessage: string };

function failure(session: AgentskyCloudSession | null, overrides: FailureOverrides): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    sessionId: session?.sessionId ?? null,
    sessionDisplayId: session?.sessionId ?? null,
    sessionParams: session,
    provider: "agentsky",
    biller: "agentsky",
    billingType: "api",
    costUsd: null,
    clearSession: false,
    ...overrides,
  };
}

function failureFromApiError(
  err: unknown,
  session: AgentskyCloudSession | null,
  phase: string,
): AdapterExecutionResult {
  if (err instanceof AgentskyApiError) {
    if (err.status === 402 || err.code === "insufficient_credits") {
      return failure(session, {
        errorMessage: `AgentSky credits exhausted while ${phase}: ${err.message}`,
        errorCode: "insufficient_credits",
        errorFamily: "provider_quota",
      });
    }
    if (err.status === 429) {
      const retrySec = Math.min(err.retryAfterSec ?? 30, 300);
      return failure(session, {
        errorMessage: `AgentSky API rate-limited while ${phase}: ${err.message}`,
        errorFamily: "transient_upstream",
        retryNotBefore: new Date(Date.now() + retrySec * 1000).toISOString(),
      });
    }
    if (session && (err.status === 404 || err.status === 409 || err.status === 410)) {
      // The remote session/agent is gone (deleted, archived, or masked by
      // authorization). Drop the persisted identity so the next heartbeat
      // re-provisions instead of failing forever.
      return failure(session, {
        errorMessage: `AgentSky session ${session.sessionId} is no longer reachable while ${phase} (${err.message}); it will be re-provisioned on the next heartbeat.`,
        sessionParams: null,
        clearSession: true,
      });
    }
    return failure(session, { errorMessage: `AgentSky API error while ${phase}: ${err.message}` });
  }
  const reason = err instanceof Error ? err.message : String(err);
  return failure(session, {
    errorMessage: `AgentSky request failed while ${phase}: ${reason}`,
    errorFamily: "transient_upstream",
  });
}

async function collectBaselineCursor(
  client: AgentskyClient,
  sessionId: string,
  startCursor: string | null,
): Promise<string | null> {
  let cursor = startCursor;
  for (;;) {
    const page = await client.listEvents(sessionId, cursor, 500);
    cursor = page.cursor ?? cursor;
    if (!page.hasMore) return cursor;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;
  const startedAt = Date.now();

  const envConfig = asStringEnvMap(config.env);
  const apiToken = asString(envConfig.AGENTSKY_API_TOKEN, "").trim();
  const priorSession = normalizeAgentskySession(runtime.sessionParams);
  if (!apiToken) {
    return failure(priorSession, { errorMessage: "AGENTSKY_API_TOKEN is required for agentsky_cloud." });
  }

  const agentSlugConfig = trimNullable(config.agentSlug);
  const harness = asString(config.harness, "").trim() || DEFAULT_AGENTSKY_HARNESS;
  if (!isAgentskyHarness(harness)) {
    return failure(priorSession, {
      errorMessage: `Unknown AgentSky harness "${harness}". Valid harnesses: ${AGENTSKY_HARNESSES.join(", ")}.`,
    });
  }
  const model = asString(config.model, "").trim() || defaultAgentskyModel(harness);
  if (!isAgentskyModelCompatible(harness, model)) {
    return failure(priorSession, {
      errorMessage: `Model "${model}" is not compatible with harness "${harness}". Valid models: ${AGENTSKY_MODELS[harness].join(", ")}.`,
    });
  }
  const apiBaseUrl =
    (asString(config.apiBaseUrl, "").trim() || DEFAULT_AGENTSKY_API_BASE_URL).replace(/\/+$/, "");
  const timeoutSecRaw = asNumber(config.timeoutSec, 3600);
  const timeoutSec = timeoutSecRaw <= 0 ? 3600 : Math.max(60, timeoutSecRaw);
  const deadline = startedAt + timeoutSec * 1000;

  const client = createAgentskyClient({ baseUrl: apiBaseUrl, token: apiToken });
  const resolved = { agentSlugConfig, harness, model, apiBaseUrl };
  const canReuseSession = sessionMatches(priorSession, resolved);

  let session: AgentskyCloudSession;
  if (canReuseSession && priorSession) {
    session = priorSession;
  } else {
    try {
      if (agentSlugConfig) {
        const remote = await client.getAgent(agentSlugConfig);
        if (remote.archived) {
          return failure(priorSession, {
            errorMessage: `AgentSky agent "${agentSlugConfig}" is archived and cannot start new sessions.`,
          });
        }
        const created = await client.createSession({
          agent: remote.slug,
          title: `Paperclip ${agent.name}`.slice(0, 120),
          metadata: { paperclipAgentId: agent.id, paperclipCompanyId: agent.companyId },
        });
        session = {
          agentSlug: remote.slug,
          sessionId: created.id,
          harness: remote.agentType ?? harness,
          model: remote.llm ?? model,
          attached: true,
          ...(apiBaseUrl !== DEFAULT_AGENTSKY_API_BASE_URL ? { apiBaseUrl } : {}),
        };
      } else {
        const created = await client.createAgent({
          name: agentskyAgentName(agent.name),
          displayName: `Paperclip ${agent.name}`.slice(0, 60),
          agentType: harness,
          llm: model,
          description: "Managed by Paperclip.",
          metadata: { paperclipAgentId: agent.id, paperclipCompanyId: agent.companyId },
        });
        const createdSession = await client.createSession({
          agent: created.slug,
          title: `Paperclip ${agent.name}`.slice(0, 120),
          metadata: { paperclipAgentId: agent.id, paperclipCompanyId: agent.companyId },
        });
        session = {
          agentSlug: created.slug,
          sessionId: createdSession.id,
          harness,
          model,
          ...(apiBaseUrl !== DEFAULT_AGENTSKY_API_BASE_URL ? { apiBaseUrl } : {}),
        };
      }
    } catch (err) {
      return failureFromApiError(err, priorSession, "provisioning the AgentSky agent");
    }
  }

  const instructions = await buildInstructionsPrefix(config, onLog);
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: canReuseSession });
  const renderedBootstrapPrompt =
    !canReuseSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const renderedPrompt =
    (canReuseSession && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData).trim();
  const runtimeNote = renderPaperclipRuntimeNote(buildPaperclipRuntimeValues(ctx));
  const prompt = joinPromptSections([
    instructions.prefix,
    renderedBootstrapPrompt,
    wakePrompt,
    runtimeNote,
    renderedPrompt,
  ]);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const finalPrompt = joinPromptSections([prompt, sessionHandoffNote]);

  const commandNotes = [
    ...instructions.notes,
    canReuseSession
      ? `Reusing AgentSky session ${session.sessionId} (agent ${session.agentSlug})`
      : session.attached
        ? `Created AgentSky session ${session.sessionId} on existing agent ${session.agentSlug}`
        : `Created AgentSky agent ${session.agentSlug} (${session.harness} / ${session.model}) with session ${session.sessionId}`,
    `AgentSky API: ${apiBaseUrl}`,
  ];

  if (onMeta) {
    const meta: AdapterInvocationMeta = {
      adapterType: "agentsky_cloud",
      command: "agentsky /api/v1",
      commandNotes,
      prompt: finalPrompt,
      promptMetrics: {
        promptChars: finalPrompt.length,
        instructionsChars: instructions.chars,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context: {
        agentskyCloud: {
          harness: session.harness,
          model: session.model,
          agentSlug: session.agentSlug,
          sessionId: session.sessionId,
          apiBaseUrl,
          canReuseSession,
        },
      },
    };
    await onMeta(meta);
  }

  await onLog(
    "stdout",
    eventLine({
      type: "agentsky_cloud.init",
      sessionId: session.sessionId,
      agentSlug: session.agentSlug,
      harness: session.harness,
      model: session.model,
    }),
  );

  // Baseline the events ledger BEFORE sending, so the poll loop only ever sees
  // events that could belong to this turn. The ledger (not the live SSE
  // stream) is the documented recovery surface, which is why this adapter
  // polls /events instead of holding /stream open; an SSE hybrid would only
  // shave latency a heartbeat does not need.
  let cursor: string | null;
  try {
    cursor = await collectBaselineCursor(client, session.sessionId, session.lastEventCursor ?? null);
  } catch (err) {
    return failureFromApiError(err, session, "reading the session event ledger");
  }

  try {
    try {
      await client.sendMessage(session.sessionId, finalPrompt);
    } catch (err) {
      if (err instanceof AgentskyApiError && err.status === 429) {
        await sleep(Math.min(err.retryAfterSec ?? 5, 30) * 1000);
        await client.sendMessage(session.sessionId, finalPrompt);
      } else {
        throw err;
      }
    }
  } catch (err) {
    return failureFromApiError(err, session, "sending the wake message");
  }
  await emitStatus(onLog, "running", `Sent wake message to AgentSky session ${session.sessionId}.`);

  let echoSeen = false;
  let ourTurnHash: string | null = null;
  let finished = false;
  let interrupted = false;
  let sessionDeleted = false;
  let stopReason: string | null = null;
  let lastMessageText = "";
  const errorEvents: string[] = [];
  let lastErrorAt: number | null = null;
  let consecutivePollFailures = 0;
  let timedOut = false;

  const emitApiEvent = async (event: AgentskyEventEnvelope) => {
    await onLog("stdout", eventLine({ type: "agentsky_cloud.message", event }));
  };

  while (!finished && !interrupted && !sessionDeleted && !timedOut) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }

    let page;
    try {
      page = await client.listEvents(session.sessionId, cursor, EVENTS_PAGE_LIMIT);
      consecutivePollFailures = 0;
    } catch (err) {
      if (err instanceof AgentskyApiError && (err.status === 404 || err.status === 410)) {
        return failureFromApiError(err, session, "polling the session event ledger");
      }
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        return failure(session, {
          errorMessage: `AgentSky event polling failed ${consecutivePollFailures} times in a row: ${
            err instanceof Error ? err.message : String(err)
          }`,
          errorFamily: "transient_upstream",
        });
      }
      const backoffMs =
        err instanceof AgentskyApiError && err.status === 429 && err.retryAfterSec
          ? Math.min(err.retryAfterSec, 30) * 1000
          : Math.min(1000 * 2 ** (consecutivePollFailures - 1), 30_000);
      await sleep(backoffMs);
      continue;
    }

    for (const event of page.events) {
      const eventTurnHash = event.id.includes("#") ? event.id.split("#")[0] : null;
      switch (event.type) {
        case "user.message": {
          if (!echoSeen) {
            const text = typeof event.text === "string" ? event.text : "";
            const channel = typeof event.channel === "string" ? event.channel : "";
            if (text === finalPrompt || channel === "api" || channel === "") echoSeen = true;
          }
          await emitApiEvent(event);
          break;
        }
        case "turn.accepted": {
          if (echoSeen && !ourTurnHash) {
            ourTurnHash = eventTurnHash;
            await emitStatus(onLog, "running", "AgentSky accepted the turn.");
          }
          break;
        }
        case "turn.status_idle": {
          const matchesOurTurn = ourTurnHash
            ? eventTurnHash === ourTurnHash
            : echoSeen; // Fallback when the accepted event was not observed.
          if (matchesOurTurn) {
            finished = true;
            stopReason = trimNullable(event.stop_reason);
          }
          break;
        }
        case "turn.interrupted": {
          const matchesOurTurn = ourTurnHash ? eventTurnHash === ourTurnHash : echoSeen;
          if (matchesOurTurn) interrupted = true;
          break;
        }
        case "session.deleted": {
          sessionDeleted = true;
          break;
        }
        case "session.updated": {
          break;
        }
        case "error": {
          const message =
            trimNullable(event.message) ?? trimNullable(event.code) ?? "AgentSky reported an unknown error.";
          errorEvents.push(message);
          lastErrorAt = Date.now();
          await onLog("stderr", `[agentsky] ${message}\n`);
          break;
        }
        case "agent.message": {
          const text = typeof event.text === "string" ? event.text : "";
          if (ourTurnHash !== null || echoSeen) {
            if (text.trim().length > 0) lastMessageText = text;
          }
          await emitApiEvent(event);
          break;
        }
        case "agent.reasoning":
        case "agent.tool_use":
        case "agent.tool_result":
        case "agent.status": {
          await emitApiEvent(event);
          break;
        }
        default:
          break;
      }
      if (finished || interrupted || sessionDeleted) break;
    }
    cursor = page.cursor ?? cursor;

    if (finished || interrupted || sessionDeleted) break;
    if (
      lastErrorAt !== null &&
      Date.now() - lastErrorAt >= ERROR_EVENT_GRACE_MS &&
      errorEvents.length > 0
    ) {
      return failure(
        { ...session, lastEventCursor: cursor ?? undefined },
        {
          errorMessage: `AgentSky reported an error and the turn did not complete: ${errorEvents[errorEvents.length - 1]}`,
          errorFamily: "transient_upstream",
        },
      );
    }
    if (!page.hasMore) await sleep(POLL_INTERVAL_MS);
  }

  const durationMs = Date.now() - startedAt;
  const nextSession: AgentskyCloudSession = {
    ...session,
    ...(cursor ? { lastEventCursor: cursor } : {}),
  };

  if (sessionDeleted) {
    await onLog(
      "stdout",
      eventLine({ type: "agentsky_cloud.result", status: "error", error: "AgentSky session was deleted." }),
    );
    return failure(null, {
      errorMessage: `AgentSky session ${session.sessionId} was deleted; it will be re-provisioned on the next heartbeat.`,
      sessionParams: null,
      clearSession: true,
      sessionId: session.sessionId,
      sessionDisplayId: session.sessionId,
    });
  }

  if (timedOut) {
    // Deliberately no interrupt: the long-lived agent may still be doing
    // useful work; the next wake resumes the same session.
    await onLog(
      "stdout",
      eventLine({
        type: "agentsky_cloud.result",
        status: "timeout",
        model: session.model,
        durationMs,
        error: `AgentSky turn did not complete within ${timeoutSec}s`,
      }),
    );
    return {
      ...failure(nextSession, {
        errorMessage: `AgentSky turn did not complete within ${timeoutSec}s.`,
      }),
      timedOut: true,
    };
  }

  if (interrupted) {
    await onLog(
      "stdout",
      eventLine({
        type: "agentsky_cloud.result",
        status: "interrupted",
        model: session.model,
        durationMs,
        error: "AgentSky turn interrupted",
      }),
    );
    return failure(nextSession, {
      errorMessage: "AgentSky turn was interrupted.",
      resultJson: {
        status: "interrupted",
        agentSlug: session.agentSlug,
        sessionId: session.sessionId,
        harness: session.harness,
        model: session.model,
      },
    });
  }

  await onLog(
    "stdout",
    eventLine({
      type: "agentsky_cloud.result",
      status: "finished",
      ...(lastMessageText ? { result: lastMessageText } : {}),
      model: session.model,
      durationMs,
    }),
  );

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionId: session.sessionId,
    sessionDisplayId: session.sessionId,
    sessionParams: nextSession,
    provider: "agentsky",
    biller: "agentsky",
    billingType: "api",
    model: session.model,
    costUsd: null,
    summary: lastMessageText ? firstNonEmptyLine(lastMessageText) : null,
    resultJson: {
      status: "finished",
      agentSlug: session.agentSlug,
      sessionId: session.sessionId,
      harness: session.harness,
      model: session.model,
      ...(stopReason ? { stopReason } : {}),
      ...(errorEvents.length > 0 ? { errors: errorEvents } : {}),
    },
    clearSession: false,
  };
}
