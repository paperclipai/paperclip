import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_SOURCE_OAUTH = "anthropic-oauth";
const CLAUDE_USAGE_SOURCE_CLI = "claude-cli";

export function claudeConfigDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".claude");
}

function hasNonEmptyProcessEnv(key: string): boolean {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function createClaudeQuotaEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("ANTHROPIC_")) continue;
    env[key] = value;
  }
  return env;
}

function stripBackspaces(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\b") {
      out = out.slice(0, -1);
    } else {
      out += char;
    }
  }
  return out;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function cleanTerminalText(text: string): string {
  return stripAnsi(stripBackspaces(text))
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n");
}

function normalizeForLabelSearch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function trimToLatestUsagePanel(text: string): string | null {
  const lower = text.toLowerCase();
  const settingsIndex = lower.lastIndexOf("settings:");
  if (settingsIndex < 0) return null;
  let tail = text.slice(settingsIndex);
  const tailLower = tail.toLowerCase();
  if (!tailLower.includes("usage")) return null;
  if (!tailLower.includes("current session") && !tailLower.includes("loading usage")) return null;
  const stopMarkers = [
    "status dialog dismissed",
    "checking for updates",
    "press ctrl-c again to exit",
  ];
  let stopIndex = -1;
  for (const marker of stopMarkers) {
    const markerIndex = tailLower.indexOf(marker);
    if (markerIndex >= 0 && (stopIndex === -1 || markerIndex < stopIndex)) {
      stopIndex = markerIndex;
    }
  }
  if (stopIndex >= 0) {
    tail = tail.slice(0, stopIndex);
  }
  return tail;
}

async function readClaudeTokenFromFile(credPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(credPath, "utf8");
  } catch {
    return null;
  }
  const credential = parseClaudeCredential(raw);
  if (!credential) return null;
  // On macOS the CLI refreshes the Keychain item, not this file, so a file
  // whose token has expired is a stale leftover. Skip it so the caller can
  // fall through to a live credential instead of failing with a dead token.
  if (credential.expiresAt != null && credential.expiresAt <= Date.now()) return null;
  return credential.token;
}

interface ClaudeCredential {
  token: string;
  /** Epoch milliseconds, when the credential file records one. */
  expiresAt: number | null;
}

function parseClaudeCredential(raw: string): ClaudeCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const oauth = obj["claudeAiOauth"];
  if (typeof oauth !== "object" || oauth === null) return null;
  const token = (oauth as Record<string, unknown>)["accessToken"];
  if (typeof token !== "string" || token.length === 0) return null;
  const expiresAt = (oauth as Record<string, unknown>)["expiresAt"];
  return { token, expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null };
}

function parseClaudeCredentialToken(raw: string): string | null {
  return parseClaudeCredential(raw)?.token ?? null;
}

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
}

export async function readClaudeAuthStatus(): Promise<ClaudeAuthStatus | null> {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"], {
      env: process.env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

function describeClaudeSubscriptionAuth(status: ClaudeAuthStatus | null): string | null {
  if (!status?.loggedIn || status.authMethod !== "claude.ai") return null;
  return status.subscriptionType
    ? `Claude is logged in via claude.ai (${status.subscriptionType})`
    : "Claude is logged in via claude.ai";
}

// Claude Code on macOS stores the OAuth credential for a custom
// CLAUDE_CONFIG_DIR in a per-directory Keychain item named
// "Claude Code-credentials-<first 8 hex chars of sha256(dir)>" instead of a
// credentials file in the directory. The suffix binds the item to exactly one
// auth home, so reading it can only ever surface the login performed inside
// that home — none of the cross-account risk of the unsuffixed operator item.
function isolatedKeychainService(configDir: string): string {
  return `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
}

async function readClaudeTokenFromKeychain(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return parseClaudeCredentialToken(stdout);
  } catch { return null; }
}

/**
 * Read the credential that a `claude` login performed inside an isolated auth
 * home left in the macOS Keychain. Only that home's own suffixed item is
 * consulted — never the unsuffixed item that holds the server operator's
 * machine-level login. Returns null off macOS.
 */
export async function readIsolatedClaudeKeychainToken(loginHome: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  return readClaudeTokenFromKeychain(isolatedKeychainService(loginHome));
}

export async function readClaudeToken(options: { allowKeychain?: boolean } = {}): Promise<string | null> {
  const configDir = claudeConfigDir();
  for (const filename of [".credentials.json", "credentials.json"]) {
    const token = await readClaudeTokenFromFile(path.join(configDir, filename));
    if (token) return token;
  }
  if (process.platform !== "darwin") return null;
  // A custom auth home owns exactly one Keychain item: the suffixed one the
  // CLI created for that directory. It must never fall through to the
  // unsuffixed item, which belongs to a different account.
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) {
    return readClaudeTokenFromKeychain(isolatedKeychainService(configDir));
  }
  // Only an explicit local-account import may consult the user's Keychain.
  if (options.allowKeychain) {
    return readClaudeTokenFromKeychain("Claude Code-credentials");
  }
  return null;
}

interface AnthropicUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface AnthropicExtraUsage {
  is_enabled?: boolean | null;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  currency?: string | null;
}

interface AnthropicUsageResponse {
  five_hour?: AnthropicUsageWindow | null;
  seven_day?: AnthropicUsageWindow | null;
  seven_day_sonnet?: AnthropicUsageWindow | null;
  seven_day_opus?: AnthropicUsageWindow | null;
  extra_usage?: AnthropicExtraUsage | null;
}

function formatCurrencyAmount(value: number, currency: string | null | undefined): string {
  const code = typeof currency === "string" && currency.trim().length > 0 ? currency.trim().toUpperCase() : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatExtraUsageLabel(extraUsage: AnthropicExtraUsage): string | null {
  const monthlyLimit = extraUsage.monthly_limit;
  const usedCredits = extraUsage.used_credits;
  if (
    typeof monthlyLimit !== "number" ||
    !Number.isFinite(monthlyLimit) ||
    typeof usedCredits !== "number" ||
    !Number.isFinite(usedCredits)
  ) {
    return null;
  }
  // API returns values in cents — convert to dollars for display
  return `${formatCurrencyAmount(usedCredits / 100, extraUsage.currency)} / ${formatCurrencyAmount(monthlyLimit / 100, extraUsage.currency)}`;
}

/** Convert a utilization value to a 0-100 integer percent. Returns null for null/undefined input.
 *  Handles both 0-1 fractions (legacy) and 0-100 percentages (current API). */
export function toPercent(utilization: number | null | undefined): number | null {
  if (utilization == null) return null;
  return Math.min(100, Math.round(utilization < 1 ? utilization * 100 : utilization));
}

/** fetch with an abort-based timeout so a hanging provider api doesn't block the response indefinitely */
export async function fetchWithTimeout(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface QuotaThrottleEntry {
  lastFetchTime: number;
  cachedWindows: QuotaWindow[] | null;
  cacheTimestamp: number | null;
  consecutiveRateLimits: number;
  backoffUntil: number | null;
  inFlight: Promise<QuotaWindow[]> | null;
}

class AnthropicUsageApiError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | undefined) {
    super(`anthropic usage api returned ${status}`);
  }
}

/** Parses a `Retry-After` header into milliseconds, defensively — only when
 * present and a non-negative number of seconds. The HTTP-date form is
 * intentionally not parsed. */
function parseRetryAfterMs(headers?: { get?(name: string): string | null }): number | undefined {
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

// Keyed by token: different local logins (different users, different
// loginHome dirs) hold different tokens and must never share cached usage
// data or a backoff window — that would leak one user's verification result
// to another and let an unverified token ride through on a cache hit.
const quotaThrottleByToken = new Map<string, QuotaThrottleEntry>();
const QUOTA_THROTTLE_MAX_ENTRIES = 200;

function getThrottleEntry(token: string): QuotaThrottleEntry {
  let entry = quotaThrottleByToken.get(token);
  if (!entry) {
    entry = {
      lastFetchTime: 0,
      cachedWindows: null,
      cacheTimestamp: null,
      consecutiveRateLimits: 0,
      backoffUntil: null,
      inFlight: null,
    };
    if (quotaThrottleByToken.size >= QUOTA_THROTTLE_MAX_ENTRIES) {
      const oldestKey = quotaThrottleByToken.keys().next().value;
      if (oldestKey !== undefined) quotaThrottleByToken.delete(oldestKey);
    }
    quotaThrottleByToken.set(token, entry);
  }
  return entry;
}

/** Test-only: clear all cached throttle state between test cases. */
export function resetClaudeQuotaThrottleForTests(): void {
  quotaThrottleByToken.clear();
}

const QUOTA_MIN_FETCH_INTERVAL_MS = 60_000;
const QUOTA_CACHE_TTL_MS = 5 * 60_000;
const QUOTA_BACKOFF_BASE_MS = 60_000;
const QUOTA_BACKOFF_MAX_MS = 15 * 60_000;
const QUOTA_BACKOFF_JITTER_MS = 5_000;

function getExponentialBackoffMs(consecutiveRateLimits: number): number {
  const baseBackoff = Math.min(
    QUOTA_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, consecutiveRateLimits - 1)),
    QUOTA_BACKOFF_MAX_MS,
  );
  const jitter = Math.random() * QUOTA_BACKOFF_JITTER_MS;
  return baseBackoff + jitter;
}

/** Anthropic rate-limits /api/oauth/usage; without throttling, a single 429
 * poisons every subsequent poll even though the last-known usage is still
 * fresh. Throttle live fetches to 1/min per token, serve a 5-min-old cache
 * while backing off, and back off exponentially (60s -> 15min, + jitter) on
 * 429s. State is scoped per-token so one user's quota check can never read
 * or block on another user's cache/backoff. */
async function fetchClaudeQuotaWithBackoff(token: string): Promise<QuotaWindow[]> {
  const now = Date.now();
  const entry = getThrottleEntry(token);

  if (entry.backoffUntil && now < entry.backoffUntil) {
    if (entry.cachedWindows && entry.cacheTimestamp && now - entry.cacheTimestamp < QUOTA_CACHE_TTL_MS) {
      return entry.cachedWindows;
    }
    throw new Error(
      `anthropic usage api rate limited; backed off until ${new Date(entry.backoffUntil).toISOString()}`,
    );
  }

  const timeSinceLastFetch = now - entry.lastFetchTime;
  if (
    timeSinceLastFetch < QUOTA_MIN_FETCH_INTERVAL_MS
    && entry.cachedWindows
    && entry.cacheTimestamp
    && now - entry.cacheTimestamp < QUOTA_CACHE_TTL_MS
  ) {
    return entry.cachedWindows;
  }

  // Reuse an in-flight request for this token rather than starting a second
  // one: lastFetchTime alone isn't atomic across concurrent callers (e.g. a
  // poll and a connection check overlapping), so without sharing the promise
  // both would pass the throttle above and double-hit Anthropic.
  if (entry.inFlight) return entry.inFlight;

  const cacheAge = entry.cacheTimestamp ? now - entry.cacheTimestamp : Infinity;
  entry.lastFetchTime = now;
  const fetchPromise = fetchClaudeQuotaDirect(token)
    .then((windows) => {
      entry.cachedWindows = windows;
      entry.cacheTimestamp = Date.now();
      entry.consecutiveRateLimits = 0;
      entry.backoffUntil = null;
      return windows;
    })
    .catch((error: unknown) => {
      if (error instanceof AnthropicUsageApiError && error.status === 429) {
        entry.consecutiveRateLimits++;
        entry.backoffUntil = now + (error.retryAfterMs ?? getExponentialBackoffMs(entry.consecutiveRateLimits));

        if (entry.cachedWindows && cacheAge < QUOTA_CACHE_TTL_MS) {
          return entry.cachedWindows;
        }
        throw new Error(
          `anthropic usage api rate limited; backed off until ${new Date(entry.backoffUntil).toISOString()}`,
        );
      }

      if (entry.cachedWindows && cacheAge < QUOTA_CACHE_TTL_MS) {
        return entry.cachedWindows;
      }
      throw error;
    })
    .finally(() => {
      entry.inFlight = null;
    });
  entry.inFlight = fetchPromise;
  return fetchPromise;
}

async function fetchClaudeQuotaDirect(token: string): Promise<QuotaWindow[]> {
  const resp = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!resp.ok) throw new AnthropicUsageApiError(resp.status, parseRetryAfterMs(resp.headers));
  const body = (await resp.json()) as AnthropicUsageResponse;
  const windows: QuotaWindow[] = [];

  if (body.five_hour != null) {
    windows.push({
      label: "Current session",
      usedPercent: toPercent(body.five_hour.utilization),
      resetsAt: body.five_hour.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day != null) {
    windows.push({
      label: "Current week (all models)",
      usedPercent: toPercent(body.seven_day.utilization),
      resetsAt: body.seven_day.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_sonnet != null) {
    windows.push({
      label: "Current week (Sonnet only)",
      usedPercent: toPercent(body.seven_day_sonnet.utilization),
      resetsAt: body.seven_day_sonnet.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_opus != null) {
    windows.push({
      label: "Current week (Opus only)",
      usedPercent: toPercent(body.seven_day_opus.utilization),
      resetsAt: body.seven_day_opus.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.extra_usage != null) {
    windows.push({
      label: "Extra usage",
      usedPercent: body.extra_usage.is_enabled === false ? null : toPercent(body.extra_usage.utilization),
      resetsAt: null,
      valueLabel:
        body.extra_usage.is_enabled === false
          ? "Not enabled"
          : formatExtraUsageLabel(body.extra_usage),
      detail:
        body.extra_usage.is_enabled === false
          ? "Extra usage not enabled"
          : "Monthly extra usage pool",
    });
  }
  return windows;
}

export async function fetchClaudeQuota(token: string): Promise<QuotaWindow[]> {
  return fetchClaudeQuotaWithBackoff(token);
}

function usageOutputLooksRelevant(text: string): boolean {
  const normalized = normalizeForLabelSearch(text);
  return normalized.includes("currentsession")
    || normalized.includes("currentweek")
    || normalized.includes("loadingusage")
    || normalized.includes("failedtoloadusagedata")
    || normalized.includes("tokenexpired")
    || normalized.includes("authenticationerror")
    || normalized.includes("ratelimited");
}

function usageOutputLooksComplete(text: string): boolean {
  const normalized = normalizeForLabelSearch(text);
  if (
    normalized.includes("failedtoloadusagedata")
    || normalized.includes("tokenexpired")
    || normalized.includes("authenticationerror")
    || normalized.includes("ratelimited")
  ) {
    return true;
  }
  return normalized.includes("currentsession")
    && (normalized.includes("currentweek") || normalized.includes("extrausage"))
    && /[0-9]{1,3}(?:\.[0-9]+)?%/i.test(text);
}

function extractUsageError(text: string): string | null {
  const lower = text.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (lower.includes("token_expired") || lower.includes("token has expired")) {
    return "Claude CLI token expired. Run `claude login` to refresh.";
  }
  if (lower.includes("authentication_error")) {
    return "Claude CLI authentication error. Run `claude login`.";
  }
  if (lower.includes("rate_limit_error") || lower.includes("rate limited") || compact.includes("ratelimited")) {
    return "Claude CLI usage endpoint is rate limited right now. Please try again later.";
  }
  if (lower.includes("failed to load usage data") || compact.includes("failedtoloadusagedata")) {
    return "Claude CLI could not load usage data. Open the CLI and retry `/usage`.";
  }
  return null;
}

function percentFromLine(line: string): number | null {
  const match = line.match(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i);
  if (!match) return null;
  const rawValue = Number(match[1]);
  if (!Number.isFinite(rawValue)) return null;
  const clamped = Math.min(100, Math.max(0, rawValue));
  const lower = line.toLowerCase();
  if (lower.includes("remaining") || lower.includes("left") || lower.includes("available")) {
    return Math.max(0, Math.min(100, Math.round(100 - clamped)));
  }
  return Math.round(clamped);
}

function isQuotaLabel(line: string): boolean {
  const normalized = normalizeForLabelSearch(line);
  return normalized === "currentsession"
    || normalized === "currentweekallmodels"
    || normalized === "currentweeksonnetonly"
    || normalized === "currentweeksonnet"
    || normalized === "currentweekopusonly"
    || normalized === "currentweekopus"
    || normalized === "extrausage";
}

function canonicalQuotaLabel(line: string): string {
  switch (normalizeForLabelSearch(line)) {
    case "currentsession":
      return "Current session";
    case "currentweekallmodels":
      return "Current week (all models)";
    case "currentweeksonnetonly":
    case "currentweeksonnet":
      return "Current week (Sonnet only)";
    case "currentweekopusonly":
    case "currentweekopus":
      return "Current week (Opus only)";
    case "extrausage":
      return "Extra usage";
    default:
      return line;
  }
}

function formatClaudeCliDetail(label: string, lines: string[]): string | null {
  const normalizedLabel = normalizeForLabelSearch(label);
  if (normalizedLabel === "extrausage") {
    const compact = lines.join(" ").replace(/\s+/g, "").toLowerCase();
    if (compact.includes("extrausagenotenabled")) {
      return "Extra usage not enabled • /extra-usage to enable";
    }
    const firstLine = lines.find((line) => line.trim().length > 0) ?? null;
    return firstLine;
  }

  const resetLine = lines.find((line) => /^resets/i.test(line) || normalizeForLabelSearch(line).startsWith("resets"));
  if (!resetLine) return null;
  return resetLine
    .replace(/^Resets/i, "Resets ")
    .replace(/([A-Z][a-z]{2})(\d)/g, "$1 $2")
    .replace(/(\d)at(\d)/g, "$1 at $2")
    .replace(/(am|pm)\(/gi, "$1 (")
    .replace(/([A-Za-z])\(/g, "$1 (")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseClaudeCliUsageText(text: string): QuotaWindow[] {
  const cleaned = trimToLatestUsagePanel(cleanTerminalText(text)) ?? cleanTerminalText(text);
  const usageError = extractUsageError(cleaned);
  if (usageError) throw new Error(usageError);

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const sections: Array<{ label: string; lines: string[] }> = [];
  let current: { label: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (isQuotaLabel(line)) {
      if (current) sections.push(current);
      current = { label: canonicalQuotaLabel(line), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  const windows = sections.map<QuotaWindow>((section) => {
    const usedPercent = section.lines.map(percentFromLine).find((value) => value != null) ?? null;
    return {
      label: section.label,
      usedPercent,
      resetsAt: null,
      valueLabel: null,
      detail: formatClaudeCliDetail(section.label, section.lines),
    };
  });

  if (!windows.some((window) => normalizeForLabelSearch(window.label) === "currentsession")) {
    throw new Error("Could not parse Claude CLI usage output.");
  }
  return windows;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildClaudeCliShellProbeCommand(): string {
  const feed = "(sleep 2; printf '/usage\\r'; sleep 6; printf '\\033'; sleep 1; printf '\\003')";
  const claudeCommand = "claude --tools \"\"";
  if (process.platform === "darwin") {
    return `${feed} | script -q /dev/null ${claudeCommand}`;
  }
  return `${feed} | script -q -e -f -c ${quoteForShell(claudeCommand)} /dev/null`;
}

export async function captureClaudeCliUsageText(timeoutMs = 12_000): Promise<string> {
  const command = buildClaudeCliShellProbeCommand();
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      env: createClaudeQuotaEnv(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = `${stdout}${stderr}`;
    const cleaned = cleanTerminalText(output);
    if (usageOutputLooksComplete(cleaned)) return output;
    throw new Error("Claude CLI usage probe ended before rendering usage.");
  } catch (error) {
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    const output = `${stdout}${stderr}`;
    const cleaned = cleanTerminalText(output);
    if (usageOutputLooksComplete(cleaned)) return output;
    if (usageOutputLooksRelevant(cleaned)) {
      throw new Error("Claude CLI usage probe ended before rendering usage.");
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function fetchClaudeCliQuota(): Promise<QuotaWindow[]> {
  const rawText = await captureClaudeCliUsageText();
  return parseClaudeCliUsageText(rawText);
}

function formatProviderError(source: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${source}: ${message}`;
}

export async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  if (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyProcessEnv("ANTHROPIC_BEDROCK_BASE_URL")
  ) {
    return { provider: "anthropic", source: "bedrock", ok: true, windows: [] };
  }

  const authStatus = await readClaudeAuthStatus();
  const authDescription = describeClaudeSubscriptionAuth(authStatus);
  const token = await readClaudeToken();

  const errors: string[] = [];

  if (token) {
    try {
      const windows = await fetchClaudeQuota(token);
      return { provider: "anthropic", source: CLAUDE_USAGE_SOURCE_OAUTH, ok: true, windows };
    } catch (error) {
      errors.push(formatProviderError("Anthropic OAuth usage", error));
    }
  }

  try {
    const windows = await fetchClaudeCliQuota();
    return { provider: "anthropic", source: CLAUDE_USAGE_SOURCE_CLI, ok: true, windows };
  } catch (error) {
    errors.push(formatProviderError("Claude CLI /usage", error));
  }

  if (hasNonEmptyProcessEnv("ANTHROPIC_API_KEY") && !authDescription) {
    return {
      provider: "anthropic",
      ok: false,
      error:
        errors[0]
        ?? "ANTHROPIC_API_KEY is set and no local Claude subscription session is available for quota polling",
      windows: [],
    };
  }

  if (authDescription) {
    return {
      provider: "anthropic",
      ok: false,
      error:
        errors.length > 0
          ? `${authDescription}, but quota polling failed (${errors.join("; ")})`
          : `${authDescription}, but Paperclip could not load subscription quota data`,
      windows: [],
    };
  }

  return {
    provider: "anthropic",
    ok: false,
    error: errors[0] ?? "no local claude auth token",
    windows: [],
  };
}
