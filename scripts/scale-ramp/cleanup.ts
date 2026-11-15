import { ApiError, type Clock, type PaperclipClient } from "./client.ts";
import { agentPrefix, companyName, mapLimit, projectName, secretPrefix, type RunState } from "./state.ts";

type Json = Record<string, any>;

export interface CleanupReport {
  agentsPaused: number;
  runsCancelled: number;
  tasksArchived: number;
  agentsTerminated: number;
  agentsDeleted: number;
  agentsKeptForCostHistory: number;
  secretDeleted: boolean;
  projectArchived: boolean;
  companyArchived: boolean;
  activeSandboxLeases: number | null;
  durationMs: number;
  errors: string[];
}

export const LIVE_RUN_STATUSES = new Set(["queued", "running", "scheduled_retry"]);
const PARALLELISM = 8;

export interface CleanupInput {
  api: PaperclipClient;
  clock: Clock;
  label: string;
  state: RunState;
  terminateWaitMs?: number;
  leaseWaitMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

export async function discoverState(api: PaperclipClient, label: string, companyId: string | null, baseUrl: string, now: number): Promise<RunState> {
  let resolved = companyId;
  let created = false;
  if (!resolved) {
    const companies = await api.get<Json[]>("/api/companies");
    const match = companies.find(company => company.name === companyName(label));
    if (!match) throw new Error(`No state file for ${label} and no company named "${companyName(label)}"; pass --company <id>`);
    resolved = String(match.id);
    created = true;
  }
  return {
    schema: "paperclip.scale-ramp.state/v1", label, baseUrl, companyId: resolved, companyCreated: created, environmentId: null,
    projectId: null, secretId: null, agentIds: [], taskIds: [], createdAt: new Date(now).toISOString(),
  };
}

export async function cleanupRun(input: CleanupInput): Promise<CleanupReport> {
  const { api, clock, label, state } = input;
  const started = clock.now();
  const pollMs = input.pollMs ?? 3_000;
  const report: CleanupReport = {
    agentsPaused: 0, runsCancelled: 0, tasksArchived: 0, agentsTerminated: 0, agentsDeleted: 0, agentsKeptForCostHistory: 0,
    secretDeleted: false, projectArchived: false, companyArchived: false, activeSandboxLeases: null, durationMs: 0, errors: [],
  };
  const attempt = async (what: string, action: () => Promise<unknown>): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (error) {
      report.errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      return false;
    }
  };
  const read = async <T>(what: string, route: string, fallback: T): Promise<T> => {
    try {
      return await api.get<T>(route);
    } catch (error) {
      report.errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      return fallback;
    }
  };
  const companyId = state.companyId;
  if (!companyId) {
    report.durationMs = clock.now() - started;
    return report;
  }
  const prefix = agentPrefix(label);
  const listed = await read<Json[]>("list agents", `/api/companies/${companyId}/agents`, []);
  const agents = listed.filter(agent => String(agent.name ?? "").startsWith(prefix));
  const agentIds = new Set(agents.map(agent => String(agent.id)));
  input.log?.(`Cleanup ${label}: ${agents.length} agents, ${state.taskIds.length} recorded tasks`);

  await mapLimit(agents.filter(agent => agent.status !== "terminated" && agent.status !== "paused"), PARALLELISM, async agent => {
    if (await attempt(`pause agent ${agent.id}`, () => api.patch(`/api/agents/${agent.id}`, { status: "paused" }))) report.agentsPaused += 1;
  });

  const runs = await read<Json[]>("list runs", `/api/companies/${companyId}/heartbeat-runs?summary=true&limit=1000`, []);
  const live = new Map<string, Json>();
  for (const run of runs) if (agentIds.has(String(run.agentId)) && LIVE_RUN_STATUSES.has(String(run.status))) live.set(String(run.id), run);
  if (runs.length >= 1_000) {
    await mapLimit([...agentIds], PARALLELISM, async agentId => {
      const own = await read<Json[]>(`list runs of ${agentId}`, `/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&summary=true&limit=50`, []);
      for (const run of own) if (LIVE_RUN_STATUSES.has(String(run.status))) live.set(String(run.id), run);
    });
  }
  await mapLimit([...live.keys()], PARALLELISM, async runId => {
    if (await attempt(`cancel run ${runId}`, () => api.post(`/api/heartbeat-runs/${runId}/cancel`))) report.runsCancelled += 1;
  });

  const taskIds = new Set(state.taskIds);
  await mapLimit([...agentIds], PARALLELISM, async agentId => {
    const issues = await read<Json[]>(`list tasks of ${agentId}`, `/api/companies/${companyId}/issues?assigneeAgentId=${agentId}&limit=500`, []);
    for (const issue of issues) if (issue.assigneeAgentId === agentId && !issue.hiddenAt) taskIds.add(String(issue.id));
  });
  await mapLimit([...taskIds], PARALLELISM, async taskId => {
    const archived = await attempt(`archive task ${taskId}`, async () => {
      try {
        await api.patch(`/api/issues/${taskId}`, { hiddenAt: new Date(clock.now()).toISOString() });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    });
    if (archived) report.tasksArchived += 1;
  });

  await mapLimit(agents.filter(agent => agent.status !== "terminated"), PARALLELISM, async agent => {
    if (await attempt(`terminate agent ${agent.id}`, () => api.post(`/api/agents/${agent.id}/terminate`))) report.agentsTerminated += 1;
  });
  const pending = new Set(agentIds);
  for (const until = clock.now() + (input.terminateWaitMs ?? 300_000); pending.size && clock.now() < until;) {
    const current = await read<Json[]>("list agents", `/api/companies/${companyId}/agents`, []);
    for (const agent of current) {
      if (!pending.has(String(agent.id))) continue;
      if (agent.status === "terminated" && (agent.lifecycleState == null || agent.lifecycleState === "terminated")) pending.delete(String(agent.id));
    }
    for (const id of [...pending]) if (!current.some(agent => String(agent.id) === id)) pending.delete(id);
    if (pending.size) await clock.sleep(pollMs);
  }
  if (pending.size) report.errors.push(`${pending.size} agents were not terminated in time; run --cleanup-only ${label} again`);
  await mapLimit([...agentIds].filter(id => !pending.has(id)), PARALLELISM, async agentId => {
    try {
      await api.delete(`/api/agents/${agentId}`);
      report.agentsDeleted += 1;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.message.includes("agent_cost_history_retained")) report.agentsKeptForCostHistory += 1;
      else report.errors.push(`delete agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
  });

  const secrets = await read<Json[]>("list secrets", `/api/companies/${companyId}/secrets`, []);
  for (const secret of secrets.filter(secret => String(secret.name ?? "").startsWith(secretPrefix(label)))) {
    if (await attempt(`delete secret ${secret.id}`, () => api.delete(`/api/secrets/${secret.id}`))) report.secretDeleted = true;
  }

  const projects = await read<Json[]>("list projects", `/api/companies/${companyId}/projects`, []);
  for (const project of projects.filter(project => project.name === projectName(label) && !project.archivedAt)) {
    if (await attempt(`archive project ${project.id}`, () => api.patch(`/api/projects/${project.id}`, { archivedAt: new Date(clock.now()).toISOString() }))) {
      report.projectArchived = true;
    }
  }

  if (state.environmentId && taskIds.size) {
    for (const until = clock.now() + (input.leaseWaitMs ?? 300_000); ;) {
      let leases: Json[] | null = null;
      try {
        leases = await api.get<Json[]>(`/api/environments/${state.environmentId}/leases?status=active`);
      } catch {
        leases = null;
      }
      if (leases === null) break;
      report.activeSandboxLeases = leases.filter(lease => taskIds.has(String(lease.issueId))).length;
      if (report.activeSandboxLeases === 0 || clock.now() >= until) break;
      await clock.sleep(pollMs);
    }
    if (report.activeSandboxLeases) report.errors.push(`${report.activeSandboxLeases} sandbox leases of this run are still active`);
  }

  if (state.companyCreated) {
    const company = await read<Json | null>("read company", `/api/companies/${companyId}`, null);
    if (company && company.name === companyName(label) && company.status !== "archived") {
      if (await attempt(`archive company ${companyId}`, () => api.post(`/api/companies/${companyId}/archive`))) report.companyArchived = true;
    }
  }
  report.durationMs = clock.now() - started;
  return report;
}
