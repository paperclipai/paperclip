import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_USAGE_SOURCE = "kimi-usage-api";
const USAGE_TIMEOUT_MS = 15_000;

/**
 * Resolve the Kimi Code home directory, honoring KIMI_CODE_HOME before the
 * default ~/.kimi-code. Mirrors the resolution used by the environment test.
 */
export function kimiCodeHome(): string {
  const fromEnv = process.env.KIMI_CODE_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".kimi-code");
}

interface KimiCredential {
  access_token: string;
  expires_at?: number;
}

/**
 * Read the OAuth access token written by `kimi login`.
 *
 * Credential files live under $KIMI_CODE_HOME/credentials/<id>.json and carry
 * access_token plus an expires_at epoch in milliseconds. A stale file is
 * skipped rather than sent, so the caller reports "not connected" instead of
 * surfacing a provider error the user cannot act on.
 */
export async function readKimiAccessToken(home: string = kimiCodeHome()): Promise<string | null> {
  const credentialsDir = path.join(home, "credentials");
  let entries: string[];
  try {
    entries = await fs.readdir(credentialsDir);
  } catch {
    return null;
  }
  let newest: KimiCredential | null = null;
  let newestExpiry = -Infinity;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(credentialsDir, entry), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const token = typeof record.access_token === "string" ? record.access_token.trim() : "";
    if (!token) continue;
    // expires_at is written in epoch seconds by `kimi login`; accept ms too.
    const rawExpiry = typeof record.expires_at === "number" ? record.expires_at : null;
    const expiresAt = rawExpiry == null ? null : rawExpiry < 1e11 ? rawExpiry * 1000 : rawExpiry;
    if (expiresAt != null && expiresAt <= Date.now()) continue;
    if ((expiresAt ?? 0) > newestExpiry) {
      newestExpiry = expiresAt ?? 0;
      newest = { access_token: token, ...(expiresAt != null ? { expires_at: expiresAt } : {}) };
    }
  }
  return newest?.access_token ?? null;
}

const PROVIDERS_TABLE_RE = /^\s*\[providers\.[^\]]+\]/m;
const PROVIDER_API_KEY_RE = /^\s*api_key\s*=\s*"([^"]+)"/m;

/**
 * Read an API key from the sources the adapter already accepts for runs:
 * the KIMI_API_KEY / KIMI_MODEL_API_KEY environment, or an api_key in
 * $KIMI_CODE_HOME/config.toml. Kimi accepts both key and OAuth tokens.
 */
export async function readKimiApiKey(home: string = kimiCodeHome()): Promise<string | null> {
  for (const name of ["KIMI_API_KEY", "KIMI_MODEL_API_KEY"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  try {
    const contents = await fs.readFile(path.join(home, "config.toml"), "utf8");
    if (!PROVIDERS_TABLE_RE.test(contents)) return null;
    const match = contents.match(PROVIDER_API_KEY_RE);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function toPercent(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  // The endpoint reports a 0..1 ratio; accept a 0..100 scale defensively.
  const percent = value <= 1 ? value * 100 : value;
  return Math.round(Math.min(100, Math.max(0, percent)) * 100) / 100;
}

function readWindow(raw: unknown): { usedPercent: number | null; resetsAt: string | null } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const resetsAt = typeof record.reset_time === "string" ? record.reset_time : null;
  return { usedPercent: toPercent(record.used_ratio), resetsAt };
}

/**
 * Map the /coding/v1/usages payload onto Paperclip quota windows.
 *
 * Window labels match how Kimi presents the same numbers in its own client.
 */
export function parseKimiUsage(payload: unknown): QuotaWindow[] {
  if (typeof payload !== "object" || payload === null) return [];
  const body = payload as Record<string, unknown>;
  const usages =
    typeof body.usages === "object" && body.usages !== null
      ? (body.usages as Record<string, unknown>)
      : {};
  const windows: QuotaWindow[] = [];

  const shortWindow = readWindow(usages.limit_5h);
  if (shortWindow) {
    const limits = Array.isArray(body.limits) ? body.limits : [];
    const first = typeof limits[0] === "object" && limits[0] !== null ? (limits[0] as Record<string, unknown>) : null;
    const detail = typeof first?.detail === "object" && first.detail !== null ? (first.detail as Record<string, unknown>) : null;
    // The endpoint serializes these as strings ("100"/"81").
    const limit = detail?.limit != null ? String(detail.limit) : null;
    const remaining = detail?.remaining != null ? String(detail.remaining) : null;
    const windowInfo = typeof first?.window === "object" && first.window !== null ? (first.window as Record<string, unknown>) : null;
    const duration = typeof windowInfo?.duration === "number" ? windowInfo.duration : null;
    const unit = typeof windowInfo?.timeUnit === "string" ? windowInfo.timeUnit : null;
    windows.push({
      label: "5 hours",
      usedPercent: shortWindow.usedPercent,
      resetsAt: shortWindow.resetsAt,
      valueLabel: limit != null && remaining != null ? `${remaining}/${limit}` : null,
      detail: duration != null ? `Limit per ${duration}${unit === "TIME_UNIT_MINUTE" ? " minutes" : " units"}` : null,
    });
  }

  for (const [key, label] of [
    ["limit_month_total", "Month (all features)"],
    ["limit_month_code", "Month (coding)"],
  ] as const) {
    const window = readWindow(usages[key]);
    if (!window) continue;
    windows.push({
      label,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
      valueLabel: null,
      detail: null,
    });
  }

  return windows;
}

/**
 * Fetch subscription quota windows from Kimi Coding.
 *
 * Kimi sells a flat subscription and reports usage as a share of the plan, so
 * there is no monetary figure to report — only the windows and their reset
 * times.
 */
export async function fetchKimiQuota(
  token: string,
  signal?: AbortSignal,
): Promise<QuotaWindow[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(KIMI_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseKimiUsage(await response.json());
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  const token = (await readKimiAccessToken()) ?? (await readKimiApiKey());
  if (!token) {
    return {
      provider: "kimi",
      source: KIMI_USAGE_SOURCE,
      ok: false,
      errorFamily: "configuration",
      error: "No Kimi credentials found. Run `kimi login` or set KIMI_API_KEY to report quota.",
      windows: [],
    };
  }

  try {
    const windows = await fetchKimiQuota(token);
    if (windows.length === 0) {
      return {
        provider: "kimi",
        source: KIMI_USAGE_SOURCE,
        ok: false,
        errorFamily: "transient_upstream",
        error: "Kimi reported no quota windows.",
        windows: [],
      };
    }
    return {
      provider: "kimi",
      accountLabel: "Kimi Coding",
      capturedAt: new Date().toISOString(),
      source: KIMI_USAGE_SOURCE,
      ok: true,
      windows,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      provider: "kimi",
      source: KIMI_USAGE_SOURCE,
      ok: false,
      errorFamily: "transient_upstream",
      error: `Kimi usage request failed: ${message}`,
      windows: [],
    };
  }
}
