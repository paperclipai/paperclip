import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runnerProfiles } from "../runner-e2e/catalog.js";
import type { SecretReference, SecretReferenceMap } from "../runner-e2e/types.js";
import { ChaosApiError } from "./api.js";
import { CREDENTIAL_FOR_ADAPTER, PROFILE_FOR_ADAPTER } from "./config.js";
import type { HostedApi } from "./hosted-api.js";
import type { HostedOptions } from "./hosted-config.js";
import { hostedIssues, type HostedIssueRow } from "./hosted-readers.js";
import { chaosLifecycleOverrides } from "./seed.js";
import { agentRunCaps } from "./staging-mix.js";
import type { AdapterId } from "./types.js";

type Json = Record<string, any>;
export type SetupApi = Pick<HostedApi, "get" | "post" | "patch" | "delete">;

export const projectName = (label: string) => `Restart chaos ${label}`;
export const agentName = (label: string, adapter: AdapterId) => `RC ${label} ${adapter}`;
export const secretName = (label: string, key: string) => `restart-chaos ${label} ${key}`;
export const taskTag = (label: string) => `[${label}]`;

export interface HostedState {
  schema: "paperclip.restart-chaos.hosted-state/v1";
  label: string;
  baseUrl: string;
  companyId: string;
  projectId: string | null;
  environmentId: string | null;
  secrets: Array<{ id: string; key: string }>;
  agents: Partial<Record<AdapterId, { id: string; name: string }>>;
  issueIds: string[];
}

export const statePath = (dir: string) => path.join(dir, "hosted-state.json");

export async function saveState(dir: string, state: HostedState): Promise<void> {
  await writeFile(statePath(dir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function loadState(dir: string): Promise<HostedState | null> {
  try { return JSON.parse(await readFile(statePath(dir), "utf8")) as HostedState; } catch { return null; }
}

export async function resolveCompany(api: SetupApi, requested: string | null): Promise<string> {
  const me = await api.get<{ companyIds?: string[] }>("/api/cli-auth/me");
  const companies = me.companyIds ?? [];
  if (requested) {
    if (!companies.includes(requested)) throw new Error(`The signed-in board user is not a member of company ${requested}`);
    return requested;
  }
  if (companies.length !== 1) throw new Error(`The signed-in user belongs to ${companies.length} companies; pass --hosted-company <id>`);
  return companies[0]!;
}

export interface InstanceInventory {
  companies: number;
  agents: number;
  activeAgents: number;
  liveRuns: number;
  openTasks: number;
}

export async function inventory(api: SetupApi, label: string | null): Promise<InstanceInventory> {
  const me = await api.get<{ companyIds?: string[] }>("/api/cli-auth/me");
  const out: InstanceInventory = { companies: 0, agents: 0, activeAgents: 0, liveRuns: 0, openTasks: 0 };
  for (const companyId of me.companyIds ?? []) {
    out.companies += 1;
    const all = await api.get<Json[]>(`/api/companies/${companyId}/agents`);
    const isOurs = (agent: Json) => label !== null && String(agent.name).startsWith(`RC ${label} `);
    const agents = all.filter(agent => !isOurs(agent));
    const ours = new Set(all.filter(isOurs).map(agent => String(agent.id)));
    out.agents += agents.length;
    out.activeAgents += agents.filter(agent => !["paused", "terminated"].includes(String(agent.status))).length;
    const live = await api.get<Json[]>(`/api/companies/${companyId}/live-runs`).catch(() => [] as Json[]);
    out.liveRuns += live.filter(run => !ours.has(String(run.agentId))).length;
    const issues = await api.get<Json[]>(`/api/companies/${companyId}/issues?limit=1000`).catch(() => [] as Json[]);
    out.openTasks += issues.filter(issue => ["todo", "in_progress"].includes(String(issue.status)) && !ours.has(String(issue.assigneeAgentId))).length;
  }
  return out;
}

export function credentialKeys(ratio: ReadonlyArray<readonly [AdapterId, number]>): Array<(typeof CREDENTIAL_FOR_ADAPTER)[AdapterId]> {
  return [...new Set(ratio.map(([adapter]) => CREDENTIAL_FOR_ADAPTER[adapter]))];
}

export async function pickEnvironment(api: SetupApi, companyId: string, requested: string | null): Promise<string> {
  const environments = await api.get<Json[]>(`/api/companies/${companyId}/environments`);
  if (requested) {
    if (!environments.some(environment => environment.id === requested)) throw new Error(`Environment ${requested} is not in company ${companyId}`);
    return requested;
  }
  const active = environments.filter(environment => environment.driver !== "local" && environment.status !== "archived");
  const sandboxes = active.filter(environment => environment.driver === "sandbox");
  const remote = sandboxes.length ? sandboxes : active;
  if (remote.length !== 1) {
    throw new Error(`Company ${companyId} has ${remote.length} sandbox environments (${remote.map(environment => `${environment.id} ${environment.driver}`).join(", ") || "none"}); `
      + "pass --hosted-environment <id>");
  }
  return String(remote[0]!.id);
}

export async function setupHosted(input: { api: SetupApi; options: HostedOptions; companyId: string; dir: string; env?: NodeJS.ProcessEnv;
  record: (kind: string, data: Record<string, unknown>) => void }): Promise<HostedState> {
  const { api, options, companyId, record } = input;
  const env = input.env ?? process.env;
  const keys = credentialKeys(options.ratio);
  const missing = keys.filter(key => !env[key]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}; run with: set -a; source ~/.secrets; set +a`);
  const state: HostedState = { schema: "paperclip.restart-chaos.hosted-state/v1", label: options.label, baseUrl: options.target.baseUrl, companyId,
    projectId: null, environmentId: null, secrets: [], agents: {}, issueIds: [] };
  await saveState(input.dir, state);
  state.environmentId = await pickEnvironment(api, companyId, options.environmentId);
  const secretRefs: SecretReferenceMap = {};
  for (const key of keys) {
    const created = await api.post<{ id: string }>(`/api/companies/${companyId}/secrets`, { name: secretName(options.label, key), value: env[key],
      description: `Restart chaos hosted run ${options.label}; removed at cleanup` });
    state.secrets.push({ id: String(created.id), key });
    await saveState(input.dir, state);
    secretRefs[key] = { type: "secret_ref", secretId: String(created.id), version: "latest" } satisfies SecretReference;
  }
  record("hosted_secrets_stored", { keys, count: state.secrets.length });
  const project = await api.post<{ id: string }>(`/api/companies/${companyId}/projects`, { name: projectName(options.label),
    description: `Restart chaos hosted release-swap run ${options.label}. Created and removed by tests/restart-chaos.` });
  state.projectId = String(project.id);
  await saveState(input.dir, state);
  const caps = agentRunCaps(options.ratio, Math.max(options.ratio.length, options.concurrency));
  for (const [adapter] of options.ratio) {
    const profile = runnerProfiles.find(candidate => candidate.id === PROFILE_FOR_ADAPTER[adapter]);
    if (!profile) throw new Error(`runner-e2e catalog has no profile ${PROFILE_FOR_ADAPTER[adapter]}`);
    const payload = profile.buildAgent({ environmentId: state.environmentId, environmentFixtureId: "daytona", workspacePath: "",
      secretRefs, executionId: options.label });
    const runtimeConfig = (payload.runtimeConfig ?? {}) as Record<string, unknown>;
    const name = agentName(options.label, adapter);
    const created = await api.post<{ id: string }>(`/api/companies/${companyId}/agents`, { ...payload, name, title: "Restart chaos hosted worker",
      adapterConfig: { ...((payload.adapterConfig ?? {}) as Record<string, unknown>), ...chaosLifecycleOverrides("warm") },
      runtimeConfig: { ...runtimeConfig, heartbeat: { ...((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>), enabled: false, maxConcurrentRuns: caps[adapter] ?? 1 } } });
    state.agents[adapter] = { id: String(created.id), name };
    await saveState(input.dir, state);
    record("hosted_agent_created", { adapter, agentId: created.id, model: profile.model, maxConcurrentRuns: caps[adapter] ?? 1 });
  }
  return state;
}

export interface CleanupReport {
  runsCancelled: number;
  tasksArchived: number;
  agentsPaused: number;
  agentsRemoved: number;
  secretsDeleted: number;
  projectArchived: boolean;
  errors: string[];
}

export const TERMINATE_WAIT_MS = 120_000;

async function removeAgent(api: SetupApi, agentId: string, pollMs: number): Promise<void> {
  const current = await api.get<Json>(`/api/agents/${agentId}`).catch(error => {
    if (error instanceof ChaosApiError && error.status === 404) return null;
    throw error;
  });
  if (current === null) return;
  if (current.status !== "terminated") await api.post(`/api/agents/${agentId}/terminate`);
  for (const until = Date.now() + TERMINATE_WAIT_MS; ;) {
    const agent = await api.get<Json>(`/api/agents/${agentId}`);
    if (agent.status === "terminated" && (agent.lifecycleState === undefined || agent.lifecycleState === null || agent.lifecycleState === "terminated")) break;
    if (Date.now() >= until) throw new Error(`agent still ${String(agent.status)} after ${TERMINATE_WAIT_MS / 1000} s; run --hosted-cleanup-only again`);
    await delay(pollMs);
  }
  try {
    await api.delete(`/api/agents/${agentId}`, { allowNotFound: true });
  } catch (error) {
    if (!(error instanceof ChaosApiError && error.status === 409 && error.message.includes("agent_cost_history_retained"))) throw error;
  }
}

export async function cleanupHosted(input: { api: SetupApi; label: string; companyId: string; state: HostedState | null;
  record: (kind: string, data: Record<string, unknown>) => void; terminatePollMs?: number }): Promise<CleanupReport> {
  const { api, label, companyId } = input;
  const report: CleanupReport = { runsCancelled: 0, tasksArchived: 0, agentsPaused: 0, agentsRemoved: 0, secretsDeleted: 0, projectArchived: false, errors: [] };
  const attempt = async (what: string, action: () => Promise<unknown>) => {
    try { await action(); return true; } catch (error) { report.errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)); return false; }
  };
  const read = async (what: string, route: string): Promise<Json[]> => {
    try { return await api.get<Json[]>(route); } catch (error) { report.errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)); return []; }
  };
  const agentPrefix = `RC ${label} `;
  const agents = (await api.get<Json[]>(`/api/companies/${companyId}/agents`)).filter(agent => String(agent.name).startsWith(agentPrefix));
  const stateIds = new Set(Object.values(input.state?.agents ?? {}).map(agent => agent!.id));
  const ours = agents.filter(agent => stateIds.size === 0 || stateIds.has(String(agent.id)));
  for (const agent of ours) {
    if (agent.status !== "terminated" && await attempt(`pause ${agent.id}`, () => api.patch(`/api/agents/${agent.id}`, { status: "paused" }))) report.agentsPaused += 1;
    const runs = await read(`read runs of ${agent.id}`, `/api/companies/${companyId}/heartbeat-runs?agentId=${agent.id}&limit=1000`);
    for (const run of runs.filter(run => run.agentId === agent.id && ["queued", "running", "scheduled_retry"].includes(String(run.status)))) {
      if (await attempt(`cancel run ${run.id}`, () => api.post(`/api/heartbeat-runs/${run.id}/cancel`))) report.runsCancelled += 1;
    }
    let issues: HostedIssueRow[] = [];
    try { issues = await hostedIssues(api, companyId, [String(agent.id)]); }
    catch (error) { report.errors.push(`read tasks of ${agent.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)); }
    for (const issue of issues.filter(issue => !issue.hidden)) {
      if (await attempt(`archive task ${issue.id}`, () => api.patch(`/api/issues/${issue.id}`, { hiddenAt: new Date().toISOString() }))) report.tasksArchived += 1;
    }
  }
  for (const agent of ours) {
    if (await attempt(`remove agent ${agent.id}`, () => removeAgent(api, String(agent.id), input.terminatePollMs ?? 2_000))) report.agentsRemoved += 1;
  }
  const secrets = (await read("read secrets", `/api/companies/${companyId}/secrets`))
    .filter(secret => String(secret.name).startsWith(`restart-chaos ${label} `));
  for (const secret of secrets) {
    if (await attempt(`delete secret ${secret.id}`, () => api.delete(`/api/secrets/${secret.id}`, { allowNotFound: true }))) report.secretsDeleted += 1;
  }
  const projects = (await read("read projects", `/api/companies/${companyId}/projects`)).filter(project => project.name === projectName(label) && !project.archivedAt);
  for (const project of projects) {
    if (await attempt(`archive project ${project.id}`, () => api.patch(`/api/projects/${project.id}`, { archivedAt: new Date().toISOString() }))) report.projectArchived = true;
  }
  input.record("hosted_cleanup", { ...report });
  return report;
}
