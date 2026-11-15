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
  agentsStillTerminating: string[];
  secretDeleted: boolean;
  projectArchived: boolean;
  companyArchived: boolean;
  activeSandboxLeases: number | null;
  activeSandboxLeaseIds: string[];
  sandboxLeasesReleasedDuringWait: number;
  durationMs: number;
  errors: string[];
}

export const LIVE_RUN_STATUSES = new Set(["queued", "running", "scheduled_retry"]);
const PARALLELISM = 8;
const TERMINATED = new Set(["terminated", "rejected"]);
const TERMINATION_READS_PER_POLL = 200;
const TERMINATION_POLL_MS_PER_AGENT = 30;
const TERMINATION_POLL_MAX_MS = 30_000;

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
    agentsPaused: 0, runsCancelled: 0, tasksArchived: 0, agentsTerminated: 0, agentsDeleted: 0, agentsKeptForCostHistory: 0, agentsStillTerminating: [],
    secretDeleted: false, projectArchived: false, companyArchived: false, activeSandboxLeases: null, activeSandboxLeaseIds: [],
    sandboxLeasesReleasedDuringWait: 0, durationMs: 0, errors: [],
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
  const readAgent = async (id: string): Promise<Json | null> => {
    try {
      return await api.get<Json>(`/api/agents/${id}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      report.errors.push(`read agent ${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      return { id, status: "unknown", lifecycleState: "unknown" };
    }
  };
  const listed = await read<Json[]>("list agents", `/api/companies/${companyId}/agents`, []);
  const agents = listed.filter(agent => String(agent.name ?? "").startsWith(prefix));
  const unlisted = state.agentIds.filter(id => !agents.some(agent => String(agent.id) === id));
  await mapLimit(unlisted, PARALLELISM, async id => {
    const agent = await readAgent(id);
    if (agent && String(agent.name ?? prefix).startsWith(prefix)) agents.push(agent);
  });
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
  const waitMs = input.terminateWaitMs ?? 300_000;
  const readPending = async (ids: string[]) => mapLimit(ids, PARALLELISM, async id => {
    const agent = await readAgent(id);
    if (!agent || TERMINATED.has(String(agent.lifecycleState))) pending.delete(id);
  });
  let cursor = 0;
  for (const until = clock.now() + waitMs; pending.size && clock.now() < until;) {
    const ids = [...pending];
    const start = cursor % ids.length;
    const batch = [...ids.slice(start), ...ids.slice(0, start)].slice(0, TERMINATION_READS_PER_POLL);
    cursor = start + batch.length;
    await readPending(batch);
    if (!pending.size) break;
    await clock.sleep(Math.min(TERMINATION_POLL_MAX_MS, Math.max(pollMs, pending.size * TERMINATION_POLL_MS_PER_AGENT)));
  }
  if (pending.size) await readPending([...pending]);
  report.agentsStillTerminating = [...pending];
  if (pending.size) {
    report.errors.push(`${pending.size} agents had not completed termination after ${Math.round(waitMs / 60_000)} min, so they were not deleted: `
      + `${[...pending].join(", ")}; run --cleanup-only ${label} again later`);
  }
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
    const leaseWaitMs = input.leaseWaitMs ?? 300_000;
    const seen = new Set<string>();
    let active: Json[] = [];
    for (const until = clock.now() + leaseWaitMs; ;) {
      let leases: Json[] | null = null;
      try {
        leases = await api.get<Json[]>(`/api/environments/${state.environmentId}/leases?status=active`);
      } catch {
        leases = null;
      }
      if (leases === null) break;
      active = leases.filter(lease => taskIds.has(String(lease.issueId)) || agentIds.has(String(lease.metadata?.agentId ?? "")));
      for (const lease of active) seen.add(String(lease.id));
      report.activeSandboxLeases = active.length;
      if (active.length === 0 || clock.now() >= until) break;
      await clock.sleep(pollMs);
    }
    report.activeSandboxLeaseIds = active.map(lease => String(lease.id));
    report.sandboxLeasesReleasedDuringWait = [...seen].filter(id => !report.activeSandboxLeaseIds.includes(id)).length;
    if (active.length) {
      const detail = active.map(lease => `${lease.id} (run ${lease.heartbeatRunId ?? "unknown"}, acquired ${lease.acquiredAt ?? "unknown"})`).join(", ");
      report.errors.push(`${active.length} sandbox leases of this run were still active after ${Math.round(leaseWaitMs / 60_000)} min: ${detail}`.slice(0, 600));
    }
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
