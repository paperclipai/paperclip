import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  asString,
  joinPromptSections,
  renderPaperclipWakePrompt,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import {
  EveStaleSessionError,
  sendFollowUp,
  startSession,
  streamSession,
} from "../shared/client.js";
import type { EveStreamEvent, EveWrapperEvent } from "../shared/events.js";

export type EveSession = {
  eveSessionId: string;
  continuationToken: string | null;
  eventIndex: number;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function trimNullable(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export function formatError(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message.trim();
  return String(err);
}

export function readSession(params: Record<string, unknown> | null): EveSession | null {
  const record = asRecord(params);
  if (!record) return null;
  const eveSessionId = trimNullable(record.eveSessionId) ?? trimNullable(record.sessionId);
  if (!eveSessionId) return null;
  const continuationToken = trimNullable(record.continuationToken);
  const rawIndex = record.eventIndex;
  const eventIndex =
    typeof rawIndex === "number" && Number.isFinite(rawIndex) && rawIndex >= 0
      ? Math.floor(rawIndex)
      : 0;
  return { eveSessionId, continuationToken, eventIndex };
}

export async function buildInstructionsPrefix(
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

export type EvePromptBuild = {
  finalPrompt: string;
  instructions: { prefix: string; notes: string[]; chars: number };
  renderedBootstrapPrompt: string;
  wakePrompt: string;
  renderedPrompt: string;
};

/** Build the wake prompt the same way for gateway and local runs. */
export async function buildEvePrompt(input: {
  ctx: AdapterExecutionContext;
  config: Record<string, unknown>;
  resumedSession: boolean;
}): Promise<EvePromptBuild> {
  const { ctx, config, resumedSession } = input;
  const { runId, agent, context, onLog } = ctx;
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
  const instructions = await buildInstructionsPrefix(config, onLog);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession });
  const renderedBootstrapPrompt =
    !resumedSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const renderedPrompt =
    resumedSession && wakePrompt.length > 0
      ? ""
      : renderTemplate(promptTemplate, templateData).trim();
  const prompt = joinPromptSections([
    instructions.prefix,
    renderedBootstrapPrompt,
    wakePrompt,
    renderedPrompt,
  ]);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const finalPrompt = joinPromptSections([prompt, sessionHandoffNote]);
  return { finalPrompt, instructions, renderedBootstrapPrompt, wakePrompt, renderedPrompt };
}

export function eventLine(event: EveWrapperEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function errorResult(input: {
  errorMessage: string;
  session?: EveSession | null;
  timedOut?: boolean;
  model?: string | null;
  resultJson?: Record<string, unknown>;
}): AdapterExecutionResult {
  const session = input.session ?? null;
  return {
    exitCode: 1,
    signal: null,
    timedOut: input.timedOut ?? false,
    errorMessage: input.errorMessage,
    ...(session
      ? {
          sessionId: session.eveSessionId,
          sessionDisplayId: session.eveSessionId,
          sessionParams: session as unknown as Record<string, unknown>,
        }
      : {}),
    provider: "eve",
    biller: "eve",
    billingType: "api",
    ...(input.model ? { model: input.model } : {}),
    costUsd: null,
    clearSession: false,
    ...(input.resultJson ? { resultJson: input.resultJson } : {}),
  };
}

type StreamAccumulator = {
  eventCount: number;
  usageInput: number;
  usageOutput: number;
  sawUsage: boolean;
  finalText: string;
  modelFromEvents: string | null;
  terminalStatus: string | null;
  failureMessage: string | null;
  inputRequested: boolean;
};

function readNumberField(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function accumulateEvent(acc: StreamAccumulator, event: EveStreamEvent): boolean {
  acc.eventCount += 1;
  const data = asRecord(event.data);

  switch (event.type) {
    case "message.completed": {
      const text =
        trimNullable(data?.text) ??
        trimNullable(data?.cumulativeText) ??
        trimNullable(data?.content);
      if (text) acc.finalText = text;
      break;
    }
    case "step.completed": {
      const usage = asRecord(data?.usage) ?? null;
      const input = readNumberField(usage, ["inputTokens", "input_tokens", "promptTokens"]);
      const output = readNumberField(usage, ["outputTokens", "output_tokens", "completionTokens"]);
      if (input !== null || output !== null) {
        acc.sawUsage = true;
        acc.usageInput += input ?? 0;
        acc.usageOutput += output ?? 0;
      }
      const model = trimNullable(data?.model);
      if (model) acc.modelFromEvents = model;
      break;
    }
    case "turn.failed": {
      acc.terminalStatus = "turn.failed";
      acc.failureMessage = trimNullable(data?.message) ?? "Eve turn failed.";
      return true;
    }
    case "session.failed": {
      acc.terminalStatus = "session.failed";
      acc.failureMessage = trimNullable(data?.message) ?? "Eve session failed.";
      return true;
    }
    // Parked/waiting states terminate the read IMMEDIATELY whenever seen:
    // `input.requested` typically fires mid-turn (a HITL approval pauses the
    // turn before any turn.completed), and Eve's durable stream stays open —
    // gating these on a turn boundary would hang until runTimeoutMs against a
    // real server. Replaying a stale prior-turn `session.waiting` is not a
    // concern: resumed runs request the stream with startIndex set past all
    // previously-consumed events.
    case "input.requested": {
      acc.inputRequested = true;
      acc.terminalStatus = "input.requested";
      return true;
    }
    case "session.waiting": {
      acc.terminalStatus = "session.waiting";
      return true;
    }
    case "session.completed": {
      acc.terminalStatus = "session.completed";
      return true;
    }
    default:
      break;
  }
  return false;
}

/**
 * Run one conversational turn against an Eve agent over HTTP: start or resume
 * the session (with stale-continuation fallback), stream events to the run
 * transcript as wrapper NDJSON lines, and build the execution result.
 *
 * Errors thrown before/while starting the session propagate to the caller,
 * which is responsible for the catch-all error result.
 */
export async function runEveTurn(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  finalPrompt: string;
  priorSession: EveSession | null;
  configModel: string | null;
  timeoutMs: number;
  runTimeoutMs: number;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<AdapterExecutionResult> {
  const { baseUrl, headers, finalPrompt, priorSession, configModel, timeoutMs, runTimeoutMs, onLog } = opts;

  // --- Start or resume the Eve session -----------------------------------
  let session: EveSession;
  let startedFresh = priorSession === null;
  if (priorSession) {
    try {
      const followUp = await sendFollowUp({
        baseUrl,
        headers,
        sessionId: priorSession.eveSessionId,
        continuationToken: priorSession.continuationToken,
        message: finalPrompt,
        timeoutMs,
      });
      session = {
        eveSessionId: priorSession.eveSessionId,
        continuationToken: followUp.continuationToken ?? priorSession.continuationToken,
        eventIndex: priorSession.eventIndex,
      };
    } catch (err) {
      if (err instanceof EveStaleSessionError) {
        await onLog(
          "stderr",
          `[paperclip] Eve session ${priorSession.eveSessionId} is stale (${err.message}); starting a fresh session.\n`,
        );
        const fresh = await startSession({ baseUrl, headers, message: finalPrompt, timeoutMs });
        session = {
          eveSessionId: fresh.sessionId,
          continuationToken: fresh.continuationToken,
          eventIndex: 0,
        };
        startedFresh = true;
      } else {
        throw err;
      }
    }
  } else {
    const fresh = await startSession({ baseUrl, headers, message: finalPrompt, timeoutMs });
    session = {
      eveSessionId: fresh.sessionId,
      continuationToken: fresh.continuationToken,
      eventIndex: 0,
    };
  }

  await onLog(
    "stdout",
    eventLine({
      type: "eve.init",
      sessionId: session.eveSessionId,
      baseUrl,
      ...(configModel ? { model: configModel } : {}),
    }),
  );

  // --- Stream events -------------------------------------------------------
  const acc: StreamAccumulator = {
    eventCount: 0,
    usageInput: 0,
    usageOutput: 0,
    sawUsage: false,
    finalText: "",
    modelFromEvents: null,
    terminalStatus: null,
    failureMessage: null,
    inputRequested: false,
  };

  const abort = new AbortController();
  let timedOut = false;
  const runTimer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, runTimeoutMs);

  try {
    await streamSession({
      baseUrl,
      headers,
      sessionId: session.eveSessionId,
      startIndex: startedFresh ? 0 : session.eventIndex,
      signal: abort.signal,
      onEvent: async (event) => {
        await onLog("stdout", eventLine({ type: "eve.event", event }));
        const done = accumulateEvent(acc, event);
        if (done) abort.abort();
      },
    });
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    clearTimeout(runTimer);
  }

  const totalEventIndex = (startedFresh ? 0 : session.eventIndex) + acc.eventCount;
  const nextSession: EveSession = {
    eveSessionId: session.eveSessionId,
    continuationToken: session.continuationToken,
    eventIndex: totalEventIndex,
  };
  const model = configModel ?? acc.modelFromEvents;
  const usage: UsageSummary | undefined = acc.sawUsage
    ? { inputTokens: acc.usageInput, outputTokens: acc.usageOutput }
    : undefined;

  if (timedOut) {
    await onLog(
      "stdout",
      eventLine({ type: "eve.result", status: "timed_out", error: `Run exceeded runTimeoutMs (${runTimeoutMs}ms).` }),
    );
    return {
      ...errorResult({
        errorMessage: `Eve run timed out after ${runTimeoutMs}ms.`,
        session: nextSession,
        timedOut: true,
        model,
      }),
      ...(usage ? { usage } : {}),
    };
  }

  const failed = acc.terminalStatus === "session.failed" || acc.terminalStatus === "turn.failed";
  if (failed) {
    const errorMessage = acc.failureMessage ?? "Eve run failed.";
    await onLog(
      "stdout",
      eventLine({ type: "eve.result", status: acc.terminalStatus ?? "failed", error: errorMessage }),
    );
    return {
      ...errorResult({
        errorMessage,
        session: nextSession,
        model,
        resultJson: {
          status: acc.terminalStatus ?? "failed",
          eveSessionId: session.eveSessionId,
          eventCount: acc.eventCount,
          eventIndex: totalEventIndex,
          error: errorMessage,
        },
      }),
      ...(usage ? { usage } : {}),
    };
  }

  const parked = acc.inputRequested;
  const summary = parked
    ? `Eve agent is waiting for human input.${acc.finalText ? ` ${firstNonEmptyLine(acc.finalText)}` : ""}`
    : firstNonEmptyLine(acc.finalText) || null;
  const status = acc.terminalStatus ?? (parked ? "input.requested" : "completed");

  await onLog(
    "stdout",
    eventLine({
      type: "eve.result",
      status,
      ...(summary ? { summary } : {}),
    }),
  );

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    ...(usage ? { usage } : {}),
    sessionId: session.eveSessionId,
    sessionDisplayId: session.eveSessionId,
    sessionParams: nextSession as unknown as Record<string, unknown>,
    provider: "eve",
    biller: "eve",
    billingType: "api",
    model: model ?? null,
    costUsd: null,
    summary,
    resultJson: {
      status,
      eveSessionId: session.eveSessionId,
      eventCount: acc.eventCount,
      eventIndex: totalEventIndex,
      ...(parked ? { inputRequested: true } : {}),
    },
    clearSession: false,
  };
}
