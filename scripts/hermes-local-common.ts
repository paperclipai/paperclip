#!/usr/bin/env -S node --import tsx
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FALLBACK_API_BASE = "http://127.0.0.1:3100/api";
const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), ".paperclip/config.json");
const DEFAULT_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID ?? "paperclip-local";
const DEFAULT_AUTH_STORE_PATH = path.join(os.homedir(), ".paperclip", "auth.json");
const DEFAULT_REPO_ROOT = process.env.PAPERCLIP_REPO_ROOT ?? process.cwd();

export interface PaperclipStartCommandOptions {
  repoRoot?: string;
  configPath?: string;
  instanceId?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function formatPaperclipStartCommand(options: PaperclipStartCommandOptions = {}): string {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const configPath = options.configPath ?? process.env.PAPERCLIP_CONFIG ?? path.join(repoRoot, ".paperclip", "config.json");
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;

  return [
    `cd ${shellQuote(repoRoot)}`,
    `PAPERCLIP_CONFIG=${shellQuote(configPath)} \\`,
    `PAPERCLIP_INSTANCE_ID=${shellQuote(instanceId)} \\`,
    "node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts run",
  ].join("\n");
}

const DEFAULT_PAPERCLIP_START_COMMAND = formatPaperclipStartCommand();

export const API_BASE = resolveApiBase();
export const API_ORIGIN = resolveApiOrigin(API_BASE);
export const BOARD_AUTH_TOKEN = resolveBoardAuthToken(API_ORIGIN);

export interface AdapterSummary {
  type: string;
  label?: string;
  source?: string;
  modelsCount?: number;
  loaded?: boolean;
  disabled?: boolean;
  overridePaused?: boolean;
}

export interface TestEnvironmentCheck {
  level: "info" | "warn" | "error";
  message: string;
  hint?: string;
  code?: string;
}

export interface TestEnvironmentResult {
  adapterType: string;
  status: "ok" | "warn" | "fail";
  checks: TestEnvironmentCheck[];
  testedAt?: string;
}

export interface CompanyRecord {
  id: string;
  name: string;
  description?: string | null;
  issuePrefix?: string | null;
  status?: string;
}

export interface AgentRecord {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  status?: string;
}

export interface IssueRecord {
  id: string;
  companyId: string;
  identifier?: string;
  title: string;
  description?: string | null;
  status: string;
  assigneeAgentId?: string | null;
  executionRunId?: string | null;
  checkoutRunId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface IssueCommentRecord {
  id: string;
  issueId: string;
  body: string;
  authorAgentId?: string | null;
  createdAt?: string;
}

export interface HeartbeatRunRecord {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  invocationSource?: string | null;
  triggerDetail?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
}

export interface HeartbeatLogResult {
  content: string;
  nextOffset: number;
  truncated?: boolean;
}

export interface HermesVersionInfo {
  raw: string;
  versionLine: string;
  pythonVersion: string | null;
}

export type DoctorSeverity = "pass" | "warn" | "fail";

export interface LocalDoctorItem {
  id: string;
  label: string;
  severity: DoctorSeverity;
  detail: string;
  hint?: string;
}

export interface LocalDoctorAutomationSummary {
  launchAgents: string[];
  serviceLoaded: boolean;
  healthcheckLoaded: boolean;
  patchRefreshLoaded: boolean;
  upstreamUpgradeLoaded: boolean;
}

export const PAPERCLIP_LAUNCH_AGENT_PREFIX = process.env.PAPERCLIP_LAUNCH_AGENT_PREFIX ?? "io.paperclip.local";

export function getPaperclipLaunchAgentExpectedNames(prefix = PAPERCLIP_LAUNCH_AGENT_PREFIX): Record<
  "service" | "healthcheck" | "patchRefresh" | "upstreamUpgrade",
  string
> {
  return {
    service: `${prefix}.service.plist`,
    healthcheck: `${prefix}.healthcheck.plist`,
    patchRefresh: `${prefix}.patch-refresh.plist`,
    upstreamUpgrade: `${prefix}.upstream-upgrade.plist`,
  };
}

export function summarizeLaunchAgents(launchAgents: string[], prefix = PAPERCLIP_LAUNCH_AGENT_PREFIX): LocalDoctorAutomationSummary {
  const expected = getPaperclipLaunchAgentExpectedNames(prefix);
  return {
    launchAgents,
    serviceLoaded: launchAgents.includes(expected.service),
    healthcheckLoaded: launchAgents.includes(expected.healthcheck),
    patchRefreshLoaded: launchAgents.includes(expected.patchRefresh),
    upstreamUpgradeLoaded: launchAgents.includes(expected.upstreamUpgrade),
  };
}

export interface LocalDoctorInput {
  apiBase: string;
  apiReachable: boolean;
  authTokenAvailable: boolean;
  health?: Record<string, unknown> | null;
  adapters: AdapterSummary[];
  companies: CompanyRecord[];
  selectedCompanyId?: string | null;
  hermesVersion?: HermesVersionInfo | null;
  testEnvironment?: TestEnvironmentResult | null;
  automation?: LocalDoctorAutomationSummary | null;
}

export interface LocalDoctorReport {
  status: DoctorSeverity;
  summary: string;
  items: LocalDoctorItem[];
}

export function classifyLocalDoctorReport(severities: DoctorSeverity[]): DoctorSeverity {
  if (severities.includes("fail")) return "fail";
  if (severities.includes("warn")) return "warn";
  return "pass";
}

export function buildLocalDoctorReport(input: LocalDoctorInput): LocalDoctorReport {
  const items: LocalDoctorItem[] = [];
  items.push({
    id: "api_health",
    label: "Paperclip API",
    severity: input.apiReachable ? "pass" : "fail",
    detail: input.apiReachable
      ? `API reachable at ${input.apiBase}${formatHealthDetail(input.health)}`
      : `Cannot reach Paperclip API at ${input.apiBase}`,
    hint: input.apiReachable ? undefined : "Start the local Paperclip service, then rerun pnpm hermes:doctor.",
  });

  items.push({
    id: "board_auth",
    label: "Board auth token",
    severity: input.authTokenAvailable ? "pass" : "warn",
    detail: input.authTokenAvailable
      ? "Board auth token is available from environment or local auth store."
      : "No Board auth token found in environment or local auth store.",
    hint: input.authTokenAvailable
      ? undefined
      : "Run Paperclip login/bootstrap flow or set PAPERCLIP_BOARD_AUTH_TOKEN/PAPERCLIP_API_KEY. Never print the token.",
  });

  const hermesAdapter = input.adapters.find((adapter) => adapter.type === "hermes_local");
  items.push({
    id: "hermes_adapter",
    label: "hermes_local adapter",
    severity: hermesAdapter && !hermesAdapter.disabled ? "pass" : "fail",
    detail: hermesAdapter
      ? `found loaded=${String(hermesAdapter.loaded)} disabled=${String(hermesAdapter.disabled)} modelsCount=${String(hermesAdapter.modelsCount ?? "unknown")}`
      : "hermes_local adapter is not listed by /api/adapters.",
    hint: hermesAdapter ? undefined : "Load the Hermes adapter through Board → Adapter manager or ~/.paperclip/adapter-plugins.json.",
  });

  items.push({
    id: "companies",
    label: "Accessible companies",
    severity: input.companies.length > 0 ? "pass" : "fail",
    detail: input.companies.length > 0
      ? `${input.companies.length} visible; selected=${input.selectedCompanyId ?? input.companies[0]?.id}`
      : "No accessible companies returned by /api/companies.",
    hint: input.companies.length > 0 ? undefined : "Create/bootstrap a company or fix Board access before running demo.",
  });

  items.push({
    id: "hermes_cli",
    label: "Hermes CLI",
    severity: input.hermesVersion ? "pass" : "fail",
    detail: input.hermesVersion
      ? `${input.hermesVersion.versionLine}${input.hermesVersion.pythonVersion ? `; Python ${input.hermesVersion.pythonVersion}` : ""}`
      : "hermes --version failed or was not run.",
    hint: input.hermesVersion ? undefined : "Install/fix Hermes CLI before using hermes_local.",
  });

  if (input.testEnvironment) {
    const errors = input.testEnvironment.checks.filter((check) => check.level === "error");
    items.push({
      id: "test_environment",
      label: "Adapter test-environment",
      severity: errors.length > 0 || input.testEnvironment.status === "fail" ? "fail" : input.testEnvironment.status === "warn" ? "warn" : "pass",
      detail: `status=${input.testEnvironment.status}; checks=${input.testEnvironment.checks.length}`,
      hint: errors.length > 0 ? errors.map(summarizeCheck).join("; ") : undefined,
    });
    for (const check of input.testEnvironment.checks) {
      if (check.level === "warn" || check.level === "error") {
        items.push({
          id: check.code ?? `test_environment_${check.level}`,
          label: `test-environment ${check.level}`,
          severity: check.level === "error" ? "fail" : "warn",
          detail: summarizeCheck(check),
          hint: check.hint,
        });
      }
    }
  } else {
    items.push({
      id: "test_environment",
      label: "Adapter test-environment",
      severity: "warn",
      detail: "test-environment was not available or was skipped.",
      hint: "Run pnpm hermes:verify for the stricter adapter readiness check.",
    });
  }

  if (input.automation) {
    const missing = [
      ["service", input.automation.serviceLoaded],
      ["healthcheck", input.automation.healthcheckLoaded],
      ["patch-refresh", input.automation.patchRefreshLoaded],
      ["upstream-upgrade", input.automation.upstreamUpgradeLoaded],
    ].filter(([, loaded]) => !loaded).map(([name]) => name);
    items.push({
      id: "automation_launchagents",
      label: "macOS LaunchAgents",
      severity: missing.includes("service") || missing.includes("healthcheck") ? "warn" : "pass",
      detail: missing.length > 0 ? `missing/not detected: ${missing.join(", ")}` : "service, healthcheck, patch-refresh, and upstream-upgrade LaunchAgents detected.",
      hint: missing.length > 0 ? "Install/load LaunchAgents if you want Paperclip to be self-healing and upgrade-aware." : undefined,
    });
  }

  const status = classifyLocalDoctorReport(items.map((item) => item.severity));
  return {
    status,
    summary: status === "pass" ? "本地 Paperclip + Hermes 工作流健康。" : status === "warn" ? "本地 Paperclip + Hermes 工作流可用但有非阻塞 warning。" : "本地 Paperclip + Hermes 工作流存在阻塞项。",
    items,
  };
}

function formatHealthDetail(health: Record<string, unknown> | null | undefined): string {
  if (!health) return "";
  const status = typeof health.status === "string" ? health.status : undefined;
  const mode = typeof health.deploymentMode === "string" ? health.deploymentMode : undefined;
  return [status ? `status=${status}` : null, mode ? `mode=${mode}` : null].filter(Boolean).join("; ").replace(/^/, " (").replace(/$/, ")");
}

function normalizeApiBase(apiBase: string): string {
  return apiBase.replace(/\/$/, "");
}

function normalizeConfigHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function resolveApiBase(): string {
  if (process.env.PAPERCLIP_API_BASE) {
    return normalizeApiBase(process.env.PAPERCLIP_API_BASE);
  }

  const configPath = process.env.PAPERCLIP_CONFIG ?? DEFAULT_CONFIG_PATH;
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as {
        server?: { host?: string; port?: number };
      };
      const host = normalizeConfigHost(parsed.server?.host || "127.0.0.1");
      const port = parsed.server?.port;
      if (typeof port === "number" && Number.isInteger(port) && port > 0) {
        return normalizeApiBase(`http://${host}:${port}/api`);
      }
    }
  } catch {
    // Fall through to the stable fallback.
  }

  return normalizeApiBase(FALLBACK_API_BASE);
}

function resolveApiOrigin(apiBase: string): string {
  try {
    const url = new URL(apiBase);
    return `${url.protocol}//${url.host}`;
  } catch {
    return apiBase.replace(/\/api\/?$/, "");
  }
}

function resolveBoardAuthToken(apiOrigin: string): string | null {
  if (process.env.PAPERCLIP_API_KEY?.trim()) return process.env.PAPERCLIP_API_KEY.trim();
  if (process.env.PAPERCLIP_BOARD_AUTH_TOKEN?.trim()) return process.env.PAPERCLIP_BOARD_AUTH_TOKEN.trim();

  const storePath = process.env.PAPERCLIP_AUTH_STORE?.trim() || DEFAULT_AUTH_STORE_PATH;
  try {
    if (!fs.existsSync(storePath)) return null;
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as {
      credentials?: Record<string, { apiBase?: string; token?: string }>;
    };
    const credentials = parsed.credentials ?? {};
    const normalizedOrigin = normalizeApiBase(apiOrigin);
    const candidates = new Set<string>([
      normalizedOrigin,
      normalizedOrigin.replace("127.0.0.1", "localhost"),
      normalizedOrigin.replace("localhost", "127.0.0.1"),
    ]);

    for (const key of candidates) {
      const token = credentials[key]?.token;
      if (typeof token === "string" && token.trim()) return token.trim();
    }

    for (const value of Object.values(credentials)) {
      const base = typeof value.apiBase === "string" ? normalizeApiBase(value.apiBase) : "";
      const token = value.token;
      if (candidates.has(base) && typeof token === "string" && token.trim()) return token.trim();
    }
  } catch {
    // Continue unauthenticated; the API will return a clear authorization error.
  }
  return null;
}

export function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

export function step(message: string): void {
  console.log(`• ${message}`);
}

export function success(message: string): void {
  console.log(`✅ ${message}`);
}

export function warn(message: string): void {
  console.warn(`⚠️  ${message}`);
}

export function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

export function summarizeCheck(check: TestEnvironmentCheck): string {
  const hint = check.hint ? ` | hint: ${check.hint}` : "";
  const code = check.code ? ` (${check.code})` : "";
  return `[${check.level}]${code} ${check.message}${hint}`;
}

export function extractCheckMessages(result: TestEnvironmentResult, level: TestEnvironmentCheck["level"]): string[] {
  return result.checks.filter((check) => check.level === level).map(summarizeCheck);
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith("http://") || path.startsWith("https://") ? path : `${API_BASE}${path}`;
  const headers = new Headers(init.headers ?? {});
  if (BOARD_AUTH_TOKEN && !headers.has("Authorization") && !headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${BOARD_AUTH_TOKEN}`);
  }
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to reach Paperclip API at ${API_BASE}. Start Paperclip first, e.g.\n\n${DEFAULT_PAPERCLIP_START_COMMAND}\n\nOriginal error: ${detail}`,
    );
  }

  const rawText = await response.text();
  const data = parseMaybeJson(rawText);
  if (!response.ok) {
    const detail = formatErrorDetail(data, rawText);
    throw new Error(`Paperclip API ${response.status} ${response.statusText} for ${url}${detail ? `: ${detail}` : ""}`);
  }
  return data as T;
}

export async function getHealth(): Promise<Record<string, unknown>> {
  return await apiRequest<Record<string, unknown>>("/health");
}

export async function getAdapters(): Promise<AdapterSummary[]> {
  return await apiRequest<AdapterSummary[]>("/adapters");
}

export async function getHermesTestEnvironment(companyId: string, adapterConfig: Record<string, unknown> = {}): Promise<TestEnvironmentResult> {
  return await apiRequest<TestEnvironmentResult>(`/companies/${companyId}/adapters/hermes_local/test-environment`, {
    method: "POST",
    body: JSON.stringify({ adapterConfig }),
  });
}

export async function getCompanies(): Promise<CompanyRecord[]> {
  return await apiRequest<CompanyRecord[]>("/companies");
}

export async function getAgents(companyId: string): Promise<AgentRecord[]> {
  return await apiRequest<AgentRecord[]>(`/companies/${companyId}/agents`);
}

export async function getHeartbeatRuns(companyId: string, agentId: string, limit = 20): Promise<HeartbeatRunRecord[]> {
  const query = new URLSearchParams({ agentId, limit: String(limit) });
  return await apiRequest<HeartbeatRunRecord[]>(`/companies/${companyId}/heartbeat-runs?${query.toString()}`);
}

export async function getHeartbeatRun(runId: string): Promise<HeartbeatRunRecord> {
  return await apiRequest<HeartbeatRunRecord>(`/heartbeat-runs/${runId}`);
}

export async function getHeartbeatRunEvents(runId: string): Promise<unknown[]> {
  return await apiRequest<unknown[]>(`/heartbeat-runs/${runId}/events`);
}

export async function getHeartbeatRunLog(runId: string, limitBytes = 12000): Promise<HeartbeatLogResult> {
  return await apiRequest<HeartbeatLogResult>(`/heartbeat-runs/${runId}/log?limitBytes=${limitBytes}`);
}

export async function getIssue(issueId: string): Promise<IssueRecord> {
  return await apiRequest<IssueRecord>(`/issues/${issueId}`);
}

export async function getIssueComments(issueId: string): Promise<IssueCommentRecord[]> {
  return await apiRequest<IssueCommentRecord[]>(`/issues/${issueId}/comments`);
}

export async function createCompany(payload: Record<string, unknown>): Promise<CompanyRecord> {
  return await apiRequest<CompanyRecord>("/companies", { method: "POST", body: JSON.stringify(payload) });
}

export async function createAgent(companyId: string, payload: Record<string, unknown>): Promise<AgentRecord> {
  return await apiRequest<AgentRecord>(`/companies/${companyId}/agents`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createAgentHire(companyId: string, payload: Record<string, unknown>): Promise<{ agent: AgentRecord; approval?: { id: string; status: string } | null }> {
  return await apiRequest<{ agent: AgentRecord; approval?: { id: string; status: string } | null }>(`/companies/${companyId}/agent-hires`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function approveApproval(approvalId: string, decisionNote = "Approved by local Hermes demo automation."): Promise<unknown> {
  return await apiRequest<unknown>(`/approvals/${approvalId}/approve`, {
    method: "POST",
    body: JSON.stringify({ decisionNote }),
  });
}

export async function createIssue(companyId: string, payload: Record<string, unknown>): Promise<IssueRecord> {
  return await apiRequest<IssueRecord>(`/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getHermesVersion(): Promise<HermesVersionInfo> {
  try {
    const { stdout, stderr } = await execFileAsync("hermes", ["--version"], { timeout: 20_000 });
    const combined = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    const versionLine = combined.split(/\r?\n/).find((line) => line.trim().length > 0) ?? combined;
    const pythonMatch = combined.match(/Python:\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
    return {
      raw: combined,
      versionLine,
      pythonVersion: pythonMatch?.[1] ?? null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to run 'hermes --version': ${detail}`);
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function truncate(text: string, maxLength = 1200): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...<truncated>`;
}

export function makeTimestampSlug(date = new Date()): string {
  const iso = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return iso.replace(/T/, "-").replace(/Z$/, "").toLowerCase();
}

export function parseMaybeJson(rawText: string): unknown {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

function formatErrorDetail(data: unknown, rawText: string): string {
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object") {
    const errorValue = (data as Record<string, unknown>).error;
    if (typeof errorValue === "string" && errorValue.trim()) return errorValue.trim();
    return truncate(JSON.stringify(data));
  }
  return rawText.trim();
}
