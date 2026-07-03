import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { normalizeBaseUrl } from "../shared/client.js";
import {
  buildEvePrompt,
  errorResult,
  eventLine,
  formatError,
  readSession,
  runEveTurn,
  trimNullable,
} from "./run-turn.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

export function asStringHeaderMap(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      headers[key] = entry;
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (rec.type === "plain" && typeof rec.value === "string") headers[key] = rec.value;
    }
  }
  return headers;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runtime, config, onLog, onMeta } = ctx;

  try {
    const rawBaseUrl = asString(config.baseUrl, "").trim();
    if (!rawBaseUrl) {
      return errorResult({
        errorMessage: "eve_gateway requires baseUrl in adapterConfig (root URL of the running Eve agent).",
      });
    }
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    const headers = asStringHeaderMap(config.headers);
    const configModel = trimNullable(config.model);
    const timeoutMs = asNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    const runTimeoutMs = asNumber(config.runTimeoutMs, DEFAULT_RUN_TIMEOUT_MS);

    const priorSession = readSession(runtime.sessionParams);
    const resumedSession = priorSession !== null;

    const promptBuild = await buildEvePrompt({ ctx, config, resumedSession });
    const { finalPrompt, instructions, renderedBootstrapPrompt, wakePrompt, renderedPrompt } = promptBuild;

    const headerNames = Object.keys(headers).sort();
    const commandNotes = [
      ...instructions.notes,
      resumedSession
        ? `Resuming Eve session ${priorSession?.eveSessionId}`
        : "Starting a new Eve session",
      `Eve agent base URL: ${baseUrl}`,
      ...(headerNames.length > 0 ? [`Configured request headers: ${headerNames.join(", ")}`] : []),
    ];

    if (onMeta) {
      const meta: AdapterInvocationMeta = {
        adapterType: "eve_gateway",
        command: baseUrl,
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
          eveGateway: {
            baseUrl,
            resumedSession,
            headerNames,
          },
        },
      };
      await onMeta(meta);
    }

    return await runEveTurn({
      baseUrl,
      headers,
      finalPrompt,
      priorSession,
      configModel,
      timeoutMs,
      runTimeoutMs,
      onLog,
    });
  } catch (err) {
    const reason = formatError(err);
    const priorSession = readSession(runtime.sessionParams);
    try {
      await onLog("stdout", eventLine({ type: "eve.result", status: "error", error: reason }));
    } catch {
      // Best effort only.
    }
    return errorResult({
      errorMessage: reason,
      session: priorSession,
      resultJson: {
        status: "error",
        ...(priorSession ? { eveSessionId: priorSession.eveSessionId } : {}),
        error: reason,
      },
    });
  }
}
