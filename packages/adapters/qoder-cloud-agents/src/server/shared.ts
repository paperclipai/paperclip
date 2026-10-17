import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { asString, isForbiddenConfigEnvKey, parseObject } from "@paperclipai/adapter-utils/server-utils";

export type QoderSleep = (ms: number, signal: AbortSignal) => Promise<void>;

export type QoderRepo = { url: string; ref: string | null; mountPath: string };

export const BUSY_SESSION_STATUSES = new Set(["running", "rescheduling"]);

export const REDACTED = "[redacted]";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asStringEnvMap(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (isForbiddenConfigEnvKey(key)) continue;
    if (typeof entry === "string") {
      env[key] = entry;
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (rec.type === "plain" && typeof rec.value === "string") env[key] = rec.value;
    }
  }
  return env;
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

export function formatRunError(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message.trim();
  return String(err);
}

export function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && entry?.type === "text")
    .map((entry) => asString(entry.text, ""))
    .join("\n")
    .trim();
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function eventLine(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

export async function emitStatus(onLog: AdapterExecutionContext["onLog"], status: string, message?: string) {
  await onLog("stdout", eventLine({ type: "qoder_cloud_agents.status", status, ...(message ? { message } : {}) }));
}
