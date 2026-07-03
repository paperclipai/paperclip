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

/**
 * Platform contract (see server/src/services/secrets.ts,
 * resolveAdapterConfigForRuntime, invoked by the heartbeat pipeline BEFORE
 * adapter.execute): all `config.env` entries and any top-level config field
 * whose schema declares `meta.secret === true` (the gateway `headers` field)
 * are resolved to plain strings before execute() runs. A whole-field secret
 * binding on `headers` therefore arrives here as a JSON *string* — accepted
 * below. Any entry still `secret_ref`-shaped INSIDE the object was never
 * resolved by the platform and cannot be resolved at the adapter layer; such
 * keys are reported in `skippedKeys` so callers can warn (key names only,
 * never values).
 */
export function parseStringMapConfig(value: unknown): {
  map: Record<string, string>;
  skippedKeys: string[];
} {
  let source: Record<string, unknown>;
  if (typeof value === "string") {
    source = {};
    if (value.trim().length > 0) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          source = parsed as Record<string, unknown>;
        }
      } catch {
        // Not a JSON object string — treat as empty.
      }
    }
  } else {
    source = parseObject(value);
  }
  const map: Record<string, string> = {};
  const skippedKeys: string[] = [];
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === "string") {
      map[key] = entry;
      continue;
    }
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (rec.type === "plain" && typeof rec.value === "string") {
        map[key] = rec.value;
        continue;
      }
    }
    skippedKeys.push(key);
  }
  return { map, skippedKeys };
}

export function asStringHeaderMap(value: unknown): Record<string, string> {
  return parseStringMapConfig(value).map;
}

export function unresolvedBindingWarning(fieldName: string, skippedKeys: string[]): string {
  return (
    `[paperclip] Ignoring unresolved bindings for ${fieldName} keys: ${skippedKeys.join(", ")}. ` +
    `secret_ref bindings inside headers/env objects are not resolved at the adapter layer; ` +
    `use the env secret-binding UI (resolved by the platform before execution) or bind the whole field as a secret.\n`
  );
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
    const { map: headers, skippedKeys: skippedHeaderKeys } = parseStringMapConfig(config.headers);
    if (skippedHeaderKeys.length > 0) {
      await onLog("stderr", unresolvedBindingWarning("header", skippedHeaderKeys));
    }
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
