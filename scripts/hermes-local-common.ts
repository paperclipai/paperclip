#!/usr/bin/env -S node --import tsx
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FALLBACK_API_BASE = "http://127.0.0.1:3100/api";
const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), ".paperclip/config.json");
const DEFAULT_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID ?? "paperclip-local";
const DEFAULT_PAPERCLIP_START_COMMAND = [
  "cd /Users/neo/projects/paperclip",
  `PAPERCLIP_CONFIG=${process.env.PAPERCLIP_CONFIG ?? DEFAULT_CONFIG_PATH} \\`,
  `PAPERCLIP_INSTANCE_ID=${DEFAULT_INSTANCE_ID} \\`,
  "node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts run",
].join("\n");

export const API_BASE = resolveApiBase();

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

function normalizeApiBase(apiBase: string): string {
  return apiBase.replace(/\/$/, "");
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
      const host = parsed.server?.host || "127.0.0.1";
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

export async function getAdapters(): Promise<AdapterSummary[]> {
  return await apiRequest<AdapterSummary[]>("/adapters");
}

export async function getHermesTestEnvironment(adapterConfig: Record<string, unknown> = {}): Promise<TestEnvironmentResult> {
  return await apiRequest<TestEnvironmentResult>("/companies/test-co/adapters/hermes_local/test-environment", {
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
