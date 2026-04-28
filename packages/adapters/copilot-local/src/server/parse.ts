import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export interface ParsedCopilotJsonl {
  sessionId: string | null;
  summary: string;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  costUsd: number | null;
  errorMessage: string | null;
  premiumRequests: number;
  totalApiDurationMs: number;
  sessionDurationMs: number;
  codeChanges: { linesAdded: number; linesRemoved: number; filesModified: string[] } | null;
  model: string | null;
}

function readCodeChanges(
  value: unknown,
): { linesAdded: number; linesRemoved: number; filesModified: string[] } | null {
  const cc = parseObject(value);
  if (Object.keys(cc).length === 0) return null;
  const filesModified = Array.isArray(cc.filesModified)
    ? (cc.filesModified as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return {
    linesAdded: asNumber(cc.linesAdded, 0),
    linesRemoved: asNumber(cc.linesRemoved, 0),
    filesModified,
  };
}

function readShutdownUsage(modelMetrics: unknown): ParsedCopilotJsonl["usage"] {
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const metrics = parseObject(modelMetrics);
  for (const value of Object.values(metrics)) {
    const metric = parseObject(value);
    const metricUsage = parseObject(metric.usage);
    usage.inputTokens += asNumber(metricUsage.inputTokens, 0);
    usage.outputTokens += asNumber(metricUsage.outputTokens, 0);
    usage.cachedInputTokens += asNumber(metricUsage.cacheReadTokens, 0);
  }
  return usage;
}

function hasUsage(value: ParsedCopilotJsonl["usage"]): boolean {
  return value.inputTokens > 0 || value.outputTokens > 0 || value.cachedInputTokens > 0;
}

export function parseCopilotJsonl(stdout: string): ParsedCopilotJsonl {
  let sessionId: string | null = null;
  let model: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const structuredUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let sawStructuredUsage = false;
  let fallbackOutputTokens = 0;
  let premiumRequests = 0;
  let totalApiDurationMs = 0;
  let sessionDurationMs = 0;
  let codeChanges: ParsedCopilotJsonl["codeChanges"] = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    const data = parseObject(event.data);

    if (type === "session.tools_updated") {
      const m = asString(data.model, "").trim();
      if (m) model = m;
      continue;
    }

    if (type === "assistant.message") {
      const content = asString(data.content, "").trim();
      if (content) messages.push(content);
      fallbackOutputTokens += asNumber(data.outputTokens, 0);
      continue;
    }

    if (type === "assistant.usage") {
      sawStructuredUsage = true;
      structuredUsage.inputTokens += asNumber(data.inputTokens, 0);
      structuredUsage.outputTokens += asNumber(data.outputTokens, 0);
      structuredUsage.cachedInputTokens += asNumber(data.cacheReadTokens, 0);
      const currentModel = asString(data.model, "").trim();
      if (currentModel) model = currentModel;
      continue;
    }

    if (type === "tool.execution_complete") {
      const success = data.success;
      const errorRec = parseObject(data.error);
      const hasError =
        success === false ||
        Object.keys(errorRec).length > 0 ||
        (typeof data.error === "string" && (data.error as string).trim().length > 0);
      if (hasError) {
        const text = errorText(data.error).trim();
        if (text) errors.push(text);
      }
      continue;
    }

    if (type === "result") {
      const sid = asString(event.sessionId, "").trim();
      if (sid) sessionId = sid;
      const usageRec = parseObject(event.usage);
      const resultUsage = {
        inputTokens: asNumber(usageRec.inputTokens, 0),
        outputTokens: asNumber(usageRec.outputTokens, 0),
        cachedInputTokens:
          asNumber(usageRec.cachedInputTokens, 0) || asNumber(usageRec.cacheReadTokens, 0),
      };
      if (hasUsage(resultUsage)) {
        sawStructuredUsage = true;
        structuredUsage.inputTokens = resultUsage.inputTokens;
        structuredUsage.outputTokens = resultUsage.outputTokens;
        structuredUsage.cachedInputTokens = resultUsage.cachedInputTokens;
      }
      premiumRequests = asNumber(usageRec.premiumRequests, 0);
      totalApiDurationMs = asNumber(usageRec.totalApiDurationMs, 0);
      sessionDurationMs = asNumber(usageRec.sessionDurationMs, 0);
      codeChanges = readCodeChanges(usageRec.codeChanges);
      continue;
    }

    if (type === "session.shutdown") {
      premiumRequests = asNumber(data.totalPremiumRequests, premiumRequests);
      totalApiDurationMs = asNumber(data.totalApiDurationMs, totalApiDurationMs);
      codeChanges = readCodeChanges(data.codeChanges) ?? codeChanges;
      const shutdownUsage = readShutdownUsage(data.modelMetrics);
      if (hasUsage(shutdownUsage)) {
        sawStructuredUsage = true;
        structuredUsage.inputTokens = shutdownUsage.inputTokens;
        structuredUsage.outputTokens = shutdownUsage.outputTokens;
        structuredUsage.cachedInputTokens = shutdownUsage.cachedInputTokens;
      }
      const shutdownModel = asString(data.currentModel, "").trim();
      if (shutdownModel) model = shutdownModel;
      const shutdownType = asString(data.shutdownType, "").trim();
      if (shutdownType === "error") {
        const reason = asString(data.errorReason, "").trim();
        if (reason) errors.push(reason);
      }
      const timestamp = Date.parse(asString(event.timestamp, ""));
      const sessionStartTime = asNumber(data.sessionStartTime, 0);
      if (Number.isFinite(timestamp) && sessionStartTime > 0) {
        sessionDurationMs = Math.max(0, timestamp - sessionStartTime);
      }
      continue;
    }

    if (type === "session.error") {
      const text = errorText(data.message ?? data.error ?? event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message ?? data.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  let summary = messages.join("\n\n").trim();
  if (!summary && premiumRequests > 0) {
    summary = `[Copilot used ${premiumRequests} premium requests]`;
  }

  const usage = sawStructuredUsage
    ? {
        inputTokens: structuredUsage.inputTokens,
        outputTokens:
          structuredUsage.outputTokens > 0
            ? structuredUsage.outputTokens
            : fallbackOutputTokens,
        cachedInputTokens: structuredUsage.cachedInputTokens,
      }
    : {
        inputTokens: 0,
        outputTokens: fallbackOutputTokens,
        cachedInputTokens: 0,
      };

  return {
    sessionId,
    summary,
    usage,
    costUsd: null,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    premiumRequests,
    totalApiDurationMs,
    sessionDurationMs,
    codeChanges,
    model,
  };
}

export function isCopilotUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /(unknown\s+session|session\b.*\bnot\s+found|no\s+such\s+session)/i.test(haystack);
}
