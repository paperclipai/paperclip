import { execFile, spawn as spawnChildProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_SOURCE_OAUTH = "anthropic-oauth";
const CLAUDE_USAGE_SOURCE_CLI = "claude-cli";

/** The macOS Keychain item that holds the default (no `CLAUDE_CONFIG_DIR`) Claude Code login. */
const CLAUDE_DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";

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
  // Claude Code draws an interactive screen and needs a real terminal type. A
  // server started by launchd or systemd often has no TERM at all.
  if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
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

/** Index of the last usage-panel header: `Settings:` in older CLIs, `Settings  Status  Config  Usage` tabs in 2.1.x. */
function lastUsagePanelHeaderIndex(lower: string): number {
  let index = -1;
  for (const match of lower.matchAll(/settings(?::|\s+status\b)/g)) index = match.index;
  return index;
}

function trimToLatestUsagePanel(text: string): string | null {
  const lower = text.toLowerCase();
  const settingsIndex = lastUsagePanelHeaderIndex(lower);
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

export interface ReadClaudeTokenOptions {
  /**
   * Whether the machine-level login in the macOS Keychain may be read when the
   * default auth home holds no credentials file. Defaults to `true`: on macOS
   * the CLI keeps the default login only in the Keychain, so a file-only read
   * can never find it. Pass `false` for a file-only read. An isolated
   * `CLAUDE_CONFIG_DIR` login is always read from its own suffixed item only.
   */
  allowKeychain?: boolean;
}

export async function readClaudeToken(options: ReadClaudeTokenOptions = {}): Promise<string | null> {
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
  if (options.allowKeychain === false) return null;
  // With no isolated auth home, the default login belongs to the account that
  // runs this process, and on macOS the CLI stores it only in the Keychain.
  // This is the same login the `claude` CLI fallback below already exercises,
  // so reading it directly adds no access the quota poll does not have today.
  return readClaudeTokenFromKeychain(CLAUDE_DEFAULT_KEYCHAIN_SERVICE);
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

/** One row of the `limits` list the usage API added alongside the fixed window fields. */
interface AnthropicUsageLimit {
  kind?: string | null;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

interface AnthropicUsageResponse {
  five_hour?: AnthropicUsageWindow | null;
  seven_day?: AnthropicUsageWindow | null;
  seven_day_sonnet?: AnthropicUsageWindow | null;
  seven_day_opus?: AnthropicUsageWindow | null;
  extra_usage?: AnthropicExtraUsage | null;
  limits?: AnthropicUsageLimit[] | null;
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

/** The usage API answered with a non-2xx status. The status drives the operator hint. */
export class ClaudeUsageApiError extends Error {
  constructor(readonly status: number) {
    super(`anthropic usage api returned ${status}`);
    this.name = "ClaudeUsageApiError";
  }
}

export async function fetchClaudeQuota(token: string): Promise<QuotaWindow[]> {
  const resp = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!resp.ok) throw new ClaudeUsageApiError(resp.status);
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
  // Newer models arrive as a model-scoped weekly limit, not as a fixed field.
  // The CLI's `/usage` panel shows each one as "Current week (<model>)".
  for (const limit of body.limits ?? []) {
    if (limit?.kind !== "weekly_scoped") continue;
    const model = limit.scope?.model?.display_name?.trim();
    if (!model) continue;
    const modelKey = normalizeForLabelSearch(model);
    if (windows.some((window) => normalizeForLabelSearch(window.label).includes(modelKey))) continue;
    windows.push({
      label: `Current week (${model})`,
      usedPercent: toPercent(limit.percent),
      resetsAt: limit.resets_at ?? null,
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

/**
 * The message the panel shows instead of usage rows, if any. Matched on text
 * with all non-alphanumerics removed, so `token_expired`, `Token has expired`
 * and the spaceless pty rendering all count.
 */
function extractUsageError(text: string): string | null {
  const compact = normalizeForLabelSearch(text);
  if (compact.includes("tokenexpired") || compact.includes("tokenhasexpired")) {
    return "Claude CLI token expired. Run `claude login` to refresh.";
  }
  if (compact.includes("authenticationerror")) {
    return "Claude CLI authentication error. Run `claude login`.";
  }
  if (compact.includes("ratelimiterror") || compact.includes("ratelimited")) {
    return "Claude CLI usage endpoint is rate limited right now. Please try again later.";
  }
  if (compact.includes("failedtoloadusagedata")) {
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

/** Longest normalized label the panel renders; longer `current week…` text is prose, not a row label. */
const MAX_QUOTA_LABEL_CHARS = 40;

function isQuotaLabel(line: string): boolean {
  const normalized = normalizeForLabelSearch(line);
  return normalized === "currentsession"
    || (normalized.startsWith("currentweek") && normalized.length <= MAX_QUOTA_LABEL_CHARS)
    || normalized === "extrausage";
}

function canonicalQuotaLabel(line: string): string {
  const normalized = normalizeForLabelSearch(line);
  switch (normalized) {
    case "currentsession":
      return "Current session";
    case "currentweek":
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
  }
  if (normalized.startsWith("currentweek")) {
    // A per-model weekly window the CLI added later, e.g. "Current week (Fable)".
    const model = line.replace(/^\s*current\s*week\s*/i, "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
    return model ? `Current week (${model})` : "Current week (all models)";
  }
  return line;
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

/** The usage panel itself reported a problem. The message is already written for the operator. */
export class ClaudeCliUsagePanelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCliUsagePanelError";
  }
}

interface UsagePanelSection {
  label: string;
  lines: string[];
}

/** Split cleaned panel text into its rows: each quota label with the lines drawn under it. */
function splitUsagePanelSections(cleaned: string): UsagePanelSection[] {
  const sections: UsagePanelSection[] = [];
  let current: UsagePanelSection | null = null;
  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (isQuotaLabel(line)) {
      if (current) sections.push(current);
      current = { label: canonicalQuotaLabel(line), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * One window per row label, in the order the labels first appeared. The REPL
 * redraws the panel as data arrives, so a capture can hold the same row more
 * than once, and a redraw can repeat a label before its new value line has
 * landed. The last drawing that carries a value is the current one; a drawing
 * without one keeps the value seen before it, so a valid quota is never shown
 * as unavailable because of a half-drawn row.
 */
function collectUsagePanelWindows(cleaned: string): QuotaWindow[] {
  const windowsByLabel = new Map<string, QuotaWindow>();
  for (const section of splitUsagePanelSections(cleaned)) {
    const previous = windowsByLabel.get(section.label);
    windowsByLabel.set(section.label, {
      label: section.label,
      usedPercent: section.lines.map(percentFromLine).find((value) => value != null) ?? previous?.usedPercent ?? null,
      resetsAt: null,
      valueLabel: null,
      detail: formatClaudeCliDetail(section.label, section.lines) ?? previous?.detail ?? null,
    });
  }
  return [...windowsByLabel.values()];
}

/** A row has rendered once its percentage is there, or, for Extra usage, its status line. */
function usagePanelWindowHasValue(window: QuotaWindow): boolean {
  if (window.usedPercent != null) return true;
  return normalizeForLabelSearch(window.label) === "extrausage" && window.detail != null;
}

export function parseClaudeCliUsageText(text: string): QuotaWindow[] {
  const cleaned = trimToLatestUsagePanel(cleanTerminalText(text)) ?? cleanTerminalText(text);
  const usageError = extractUsageError(cleaned);
  if (usageError) throw new ClaudeCliUsagePanelError(usageError);

  const windows = collectUsagePanelWindows(cleaned);
  if (!windows.some((window) => normalizeForLabelSearch(window.label) === "currentsession")) {
    throw new Error("Could not parse Claude CLI usage output.");
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Interactive `claude` CLI fallback: `/usage` driven by what the REPL renders
// ---------------------------------------------------------------------------

/**
 * Why the interactive `/usage` probe did not deliver a usage panel.
 *
 *   - `spawn_error`: the pty wrapper or the `claude` binary could not start.
 *   - `trust_prompt`: Claude Code asked whether to trust the working folder.
 *     The probe never answers that question on the operator's behalf.
 *   - `login_required`: Claude Code asked for a login before showing a prompt.
 *   - `prompt_timeout`: the REPL prompt did not render before the deadline.
 *   - `exited_before_prompt`: the CLI exited before it rendered a prompt.
 *   - `usage_timeout`: `/usage` was typed but no panel rendered in time.
 *   - `exited_before_usage`: the CLI exited after `/usage` without a panel.
 */
export type ClaudeCliUsageProbeFailure =
  | "spawn_error"
  | "trust_prompt"
  | "login_required"
  | "prompt_timeout"
  | "exited_before_prompt"
  | "usage_timeout"
  | "exited_before_usage";

/**
 * A failure of the interactive probe. The message names the observed state and
 * never carries the spawned command line, raw terminal output, or a shell
 * error, so it is safe to surface and to log.
 */
export class ClaudeCliUsageProbeError extends Error {
  constructor(
    readonly reason: ClaudeCliUsageProbeFailure,
    message: string,
    readonly cwd: string,
    /** The cleaned terminal text seen before the failure, bounded. For diagnostics only, never for the UI. */
    readonly transcript: string | null = null,
  ) {
    super(message);
    this.name = "ClaudeCliUsageProbeError";
  }
}

export interface ClaudeCliUsageProbeOptions {
  /** How long to wait for the REPL prompt before giving up. Default 10s. */
  promptTimeoutMs?: number;
  /** How long to wait for the usage panel after `/usage` is typed. Default 8s. */
  usageTimeoutMs?: number;
  /** Quiet time during which the panel must look complete before it is closed; a chunk of output restarts it. Default 750ms. */
  settleMs?: number;
  /** How long the CLI may take to exit after Escape and Ctrl-C before it is killed. Default 1.5s. */
  exitGraceMs?: number;
  /** Working directory for the CLI. Defaults to the server's own working directory. */
  cwd?: string;
  /** Test seam: the spawn implementation that starts the pty wrapper. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Test seam: how the probe process tree is signalled. Defaults to a process-group kill. */
  kill?: (child: ChildProcess, signal: NodeJS.Signals) => void;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 10_000;
const DEFAULT_USAGE_TIMEOUT_MS = 8_000;
/** A pause of up to this long between two drawings of the panel extends the capture rather than ending it. */
const DEFAULT_SETTLE_MS = 750;
const DEFAULT_EXIT_GRACE_MS = 1_500;
/** Gap between the keystrokes that close the panel and exit the REPL, so a terminal key parser never reads Escape + Ctrl-C as one chord. */
const CLOSE_KEYSTROKE_GAP_MS = 120;
/** Upper bound on buffered terminal output. The usage panel is a few kilobytes; this stops a chatty REPL from growing memory without limit. */
const MAX_PROBE_OUTPUT_CHARS = 1024 * 1024;
/** Upper bound on the transcript a probe failure carries for diagnostics. */
const MAX_TRANSCRIPT_CHARS = 8_000;

const USAGE_COMMAND_KEYS = "/usage\r";
const ESCAPE_KEY = "\u001b";
const CTRL_C_KEY = "\u0003";

/**
 * The pty wrapper that gives `claude` a terminal. Node hands a child a socket
 * pair for its stdin, and the BSD `script` on macOS refuses a socket there
 * ("tcgetattr/ioctl: Operation not supported on socket"). A `cat` stage turns
 * the socket into the plain pipe `script` accepts. The CLI command is passed
 * as positional parameters, so the shell never parses it.
 */
function buildClaudeCliProbeInvocation(): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "sh", args: ["-c", 'cat | script -q /dev/null "$@"', "claude-usage-probe", "claude", "--tools", ""] };
  }
  return { command: "sh", args: ["-c", 'cat | script -q -e -f -c "$1" /dev/null', "claude-usage-probe", 'claude --tools ""'] };
}

/**
 * Signal the probe's whole process group: the shell, the `cat` stage and
 * `script`. Closing `script` hangs up the pseudo-terminal, which ends `claude`.
 */
function killClaudeCliProbeTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* the group is gone or was never created; fall back to the leader */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

// The REPL draws its screen with cursor moves, so a captured line often has
// its spaces missing ("Quicksafetycheck:Isthisaproject…"). Every marker below
// is matched on text with all non-alphanumerics removed, like the labels above.
const PROMPT_READY_MARKERS = ["forshortcuts", "shifttabtocycle", "bypasspermissions"];
const TRUST_PROMPT_MARKERS = ["trustthisfolder", "quicksafetycheck", "doyoutrustthefiles"];
const LOGIN_REQUIRED_MARKERS = ["selectloginmethod", "notloggedin", "logintocontinue"];

/**
 * True once the REPL has drawn its input prompt. Claude Code 2.x renders a
 * `❯` prompt with a `Try "…"` hint and a footer line that names the shortcut
 * key or the permission mode. Any one of those means the REPL reads keystrokes.
 * A bare `❯` is not enough: selection dialogs use it as their cursor too.
 */
export function claudeCliPromptLooksReady(cleanedText: string): boolean {
  const normalized = normalizeForLabelSearch(cleanedText);
  if (PROMPT_READY_MARKERS.some((marker) => normalized.includes(marker))) return true;
  return /❯\s*try\b/i.test(cleanedText);
}

/**
 * A state the REPL shows instead of a prompt. The probe stops at either one:
 * trusting a folder or logging in are decisions for the operator.
 */
export function detectClaudeCliStartupBlocker(cleanedText: string): "trust_prompt" | "login_required" | null {
  const normalized = normalizeForLabelSearch(cleanedText);
  if (TRUST_PROMPT_MARKERS.some((marker) => normalized.includes(marker))) return "trust_prompt";
  if (LOGIN_REQUIRED_MARKERS.some((marker) => normalized.includes(marker))) return "login_required";
  return null;
}

/**
 * True once the `/usage` panel has rendered every row it has started: the
 * `Current session` row, at least one weekly or Extra usage row, and a value
 * under each label. A label whose value has not landed yet leaves the panel
 * incomplete. The REPL footer shows a percentage of its own before the panel
 * opens, so a percentage counts only when it follows a row label. A usage
 * error shown in place of the rows is a finished panel too.
 */
export function claudeCliUsagePanelLooksComplete(cleanedText: string): boolean {
  if (extractUsageError(cleanedText)) return true;
  const windows = collectUsagePanelWindows(cleanedText);
  if (!windows.some((window) => normalizeForLabelSearch(window.label) === "currentsession")) return false;
  if (!windows.some((window) => normalizeForLabelSearch(window.label) !== "currentsession")) return false;
  return windows.every(usagePanelWindowHasValue);
}

function describeSpawnFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
  if (code === "ENOENT") return "The `claude` command or the `script` pty helper was not found on PATH.";
  return code ? `The Claude CLI could not start (${code}).` : "The Claude CLI could not start.";
}

/**
 * Open the interactive `claude` REPL in a pseudo-terminal, type `/usage` once
 * the prompt has rendered, and return the raw terminal output once the panel
 * has rendered. Every step waits on observed output, not on a fixed sleep:
 * the prompt wait, the panel wait and the exit wait each have their own
 * deadline. The probe stops without typing anything when the REPL asks to
 * trust the folder or to log in.
 */
export async function captureClaudeCliUsageText(options: ClaudeCliUsageProbeOptions = {}): Promise<string> {
  const promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const usageTimeoutMs = options.usageTimeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const exitGraceMs = options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
  const cwd = options.cwd ?? process.cwd();
  const spawnImpl = options.spawn ?? spawnChildProcess;
  const killImpl = options.kill ?? killClaudeCliProbeTree;
  const { command, args } = buildClaudeCliProbeInvocation();

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      // `detached` puts the shell, `cat` and `script` in their own process
      // group, so one signal reaches all of them when the probe has to stop.
      child = spawnImpl(command, args, { cwd, env: createClaudeQuotaEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (error) {
      reject(new ClaudeCliUsageProbeError("spawn_error", describeSpawnFailure(error), cwd));
      return;
    }

    // A keystroke written to a REPL that has just exited surfaces as an
    // asynchronous `error` on the pipe, not as a throw from `write()`. With no
    // listener, Node treats it as an uncaught exception and the server dies.
    // Every such case ends with the child's `close` event, which settles the
    // result, so the stream error itself needs no handling.
    const ignoreStreamError = () => {};
    child.stdin?.on("error", ignoreStreamError);
    child.stdout?.on("error", ignoreStreamError);
    child.stderr?.on("error", ignoreStreamError);

    type Phase = "waiting_for_prompt" | "waiting_for_usage" | "closing";
    let phase: Phase = "waiting_for_prompt";
    let settled = false;
    let raw = "";
    let captured = "";
    const decoder = new StringDecoder("utf8");
    const timers = new Set<NodeJS.Timeout>();

    const after = (ms: number, fn: () => void): NodeJS.Timeout => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
      return timer;
    };
    const cancel = (timer: NodeJS.Timeout | null) => {
      if (!timer) return;
      clearTimeout(timer);
      timers.delete(timer);
    };
    const terminate = () => {
      killImpl(child, "SIGTERM");
      const hardKill = setTimeout(() => killImpl(child, "SIGKILL"), 1_000);
      hardKill.unref();
    };
    const finish = (outcome: { value: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const probeError = (reason: ClaudeCliUsageProbeFailure, message: string) =>
      new ClaudeCliUsageProbeError(reason, message, cwd, cleanTerminalText(raw).slice(-MAX_TRANSCRIPT_CHARS));
    const fail = (reason: ClaudeCliUsageProbeFailure, message: string) => {
      finish({ error: probeError(reason, message) });
      terminate();
    };
    const type = (keys: string) => {
      try { child.stdin?.write(keys); } catch { /* the REPL is gone; the close handler settles the result */ }
    };

    let phaseDeadline: NodeJS.Timeout | null = after(promptTimeoutMs, () => {
      fail("prompt_timeout", `The Claude CLI did not show its prompt within ${Math.round(promptTimeoutMs / 1000)}s.`);
    });
    let settleTimer: NodeJS.Timeout | null = null;

    const closePanelAndExit = () => {
      phase = "closing";
      captured = raw;
      type(ESCAPE_KEY);
      after(CLOSE_KEYSTROKE_GAP_MS, () => type(CTRL_C_KEY));
      after(CLOSE_KEYSTROKE_GAP_MS * 2, () => {
        type(CTRL_C_KEY);
        try { child.stdin?.end(); } catch { /* already closed */ }
      });
      after(CLOSE_KEYSTROKE_GAP_MS * 2 + exitGraceMs, () => {
        // The capture is already complete; a slow exit must not fail the poll.
        finish({ value: captured });
        terminate();
      });
    };

    const onOutput = (chunk: Buffer | string) => {
      if (settled) return;
      raw += typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (raw.length > MAX_PROBE_OUTPUT_CHARS) raw = raw.slice(-MAX_PROBE_OUTPUT_CHARS);
      if (phase === "closing") return;
      const cleaned = cleanTerminalText(raw);

      if (phase === "waiting_for_prompt") {
        const blocker = detectClaudeCliStartupBlocker(cleaned);
        if (blocker === "trust_prompt") {
          fail("trust_prompt", `Claude Code asked to trust the folder ${cwd} before it would start.`);
          return;
        }
        if (blocker === "login_required") {
          fail("login_required", "Claude Code asked for a login before it would show a prompt.");
          return;
        }
        if (!claudeCliPromptLooksReady(cleaned)) return;
        phase = "waiting_for_usage";
        cancel(phaseDeadline);
        phaseDeadline = after(usageTimeoutMs, () => {
          fail("usage_timeout", `The Claude CLI did not render the usage panel within ${Math.round(usageTimeoutMs / 1000)}s.`);
        });
        type(USAGE_COMMAND_KEYS);
        return;
      }

      if (phase === "waiting_for_usage") {
        // The panel closes only after `settleMs` of quiet during which every
        // row it has started carries a value. Each chunk restarts that wait,
        // so a row that is still loading or a redraw in progress extends the
        // capture instead of cutting it short.
        cancel(settleTimer);
        settleTimer = null;
        if (!claudeCliUsagePanelLooksComplete(cleaned)) return;
        settleTimer = after(settleMs, () => {
          cancel(phaseDeadline);
          closePanelAndExit();
        });
      }
    };

    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.on("error", (error) => {
      finish({ error: probeError("spawn_error", describeSpawnFailure(error)) });
    });
    child.on("close", () => {
      if (settled) return;
      raw += decoder.end();
      if (phase === "closing") {
        finish({ value: captured });
        return;
      }
      if (claudeCliUsagePanelLooksComplete(cleanTerminalText(raw))) {
        finish({ value: raw });
        return;
      }
      finish({
        error: phase === "waiting_for_prompt"
          ? probeError("exited_before_prompt", "The Claude CLI exited before it showed a prompt.")
          : probeError("exited_before_usage", "The Claude CLI exited before it rendered the usage panel."),
      });
    });
  });
}

export async function fetchClaudeCliQuota(options: ClaudeCliUsageProbeOptions = {}): Promise<QuotaWindow[]> {
  const rawText = await captureClaudeCliUsageText(options);
  return parseClaudeCliUsageText(rawText);
}

// ---------------------------------------------------------------------------
// Aggregation and the operator-facing message
// ---------------------------------------------------------------------------

const CLAUDE_LOGIN_HINT = "Run `claude login` on the machine that runs Paperclip, then retry.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return error instanceof TypeError && /fetch failed|network/i.test(error.message);
}

/**
 * One sentence the operator can act on, chosen from what the two attempts
 * observed. A CLI blocker (folder trust, missing binary) outranks an OAuth
 * status, because the OAuth status may only reflect an expired access token
 * that the CLI would have refreshed.
 */
export function describeClaudeQuotaHint(input: { oauthError?: unknown; cliError?: unknown }): string {
  const { oauthError, cliError } = input;
  if (cliError instanceof ClaudeCliUsageProbeError) {
    if (cliError.reason === "trust_prompt") {
      return `Claude Code is waiting for you to trust the folder ${cliError.cwd}. Open Claude Code in that folder once and accept the prompt, then retry.`;
    }
    if (cliError.reason === "spawn_error") {
      return "Paperclip could not start the `claude` command. Install Claude Code on the machine that runs Paperclip and make sure it is on PATH, then retry.";
    }
    if (cliError.reason === "login_required") return CLAUDE_LOGIN_HINT;
  }
  if (oauthError instanceof ClaudeUsageApiError) {
    if (oauthError.status === 401 || oauthError.status === 403) {
      return "The saved Claude login is no longer valid. Run `claude login` on the machine that runs Paperclip, then retry.";
    }
    if (oauthError.status === 429) return "Anthropic is rate limiting usage checks right now. Try again in a few minutes.";
  }
  if (isNetworkFailure(oauthError)) return "Paperclip could not reach Anthropic. Check the network connection, then retry.";
  // A problem the usage panel itself reported is already written for the operator.
  if (cliError instanceof ClaudeCliUsagePanelError) return cliError.message;
  if (cliError instanceof ClaudeCliUsageProbeError) return "Claude Code did not answer in time. Retry in a moment.";
  return CLAUDE_LOGIN_HINT;
}

let lastLoggedQuotaFailure: string | null = null;

/** Keep the diagnostic detail in the server log, once per distinct failure, so the UI never shows it. */
function logClaudeQuotaFailure(attempts: string[]): void {
  const signature = attempts.join(" | ");
  if (signature === lastLoggedQuotaFailure) return;
  lastLoggedQuotaFailure = signature;
  console.warn("[paperclip] Claude subscription quota polling failed", { attempts });
}

/** Test seam: forget the last logged failure so the next one logs again. */
export function resetClaudeQuotaFailureLogForTests(): void {
  lastLoggedQuotaFailure = null;
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

  const attempts: string[] = [];
  let oauthError: unknown;
  let cliError: unknown;

  if (token) {
    try {
      const windows = await fetchClaudeQuota(token);
      return { provider: "anthropic", source: CLAUDE_USAGE_SOURCE_OAUTH, ok: true, windows };
    } catch (error) {
      oauthError = error;
      attempts.push(`Anthropic OAuth usage: ${errorMessage(error)}`);
    }
  } else {
    attempts.push("Anthropic OAuth usage: no local Claude login token was found");
  }

  try {
    const windows = await fetchClaudeCliQuota();
    return { provider: "anthropic", source: CLAUDE_USAGE_SOURCE_CLI, ok: true, windows };
  } catch (error) {
    cliError = error;
    attempts.push(`Claude CLI /usage: ${errorMessage(error)}`);
  }

  logClaudeQuotaFailure(attempts);
  const hint = describeClaudeQuotaHint({ oauthError, cliError });

  if (hasNonEmptyProcessEnv("ANTHROPIC_API_KEY") && !authDescription && !token) {
    return {
      provider: "anthropic",
      ok: false,
      error: "ANTHROPIC_API_KEY is set and no local Claude subscription session is available for quota polling",
      windows: [],
    };
  }

  return {
    provider: "anthropic",
    ok: false,
    error: authDescription
      ? `${authDescription}, but Paperclip could not read the subscription quota. ${hint}`
      : `Paperclip could not read the Claude subscription quota. ${hint}`,
    windows: [],
  };
}
