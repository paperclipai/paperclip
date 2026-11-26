import { ApiError, type Clock, type PaperclipClient } from "./client.ts";
import type { AgentProfile, Options } from "./config.ts";
import { agentName, companyName, mapLimit, projectName, secretPrefix, type RunState, type StateStore } from "./state.ts";

type Json = Record<string, any>;

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

export async function resolveCompany(api: PaperclipClient, options: Pick<Options, "companyId" | "label">, state: RunState, store: StateStore): Promise<void> {
  if (options.companyId) {
    const me = await api.get<{ companyIds?: string[] }>("/api/cli-auth/me");
    if (!(me.companyIds ?? []).includes(options.companyId)) throw new SetupError(`The signed-in board user is not a member of company ${options.companyId}`);
    state.companyId = options.companyId;
    await store.save(state);
    return;
  }
  try {
    const company = await api.post<{ id: string }>("/api/companies", {
      name: companyName(options.label),
      description: `Scale ramp ${options.label}. Created and archived by scripts/scale-agents-ramp.ts.`,
    });
    state.companyId = String(company.id);
    state.companyCreated = true;
    await store.save(state);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      throw new SetupError(`This instance does not let the harness create a company (${error.code ?? "forbidden"}); pass --company <id> or PAPERCLIP_SCALE_COMPANY_ID`);
    }
    throw error;
  }
}

export async function pickEnvironment(api: PaperclipClient, companyId: string, requested: string | null, allowLocal: boolean): Promise<string> {
  const environments = await api.get<Json[]>(`/api/companies/${companyId}/environments`);
  if (requested) {
    if (!environments.some(environment => environment.id === requested)) throw new SetupError(`Environment ${requested} is not in the company`);
    return requested;
  }
  const active = environments.filter(environment => environment.status !== "archived" && (allowLocal || environment.driver !== "local"));
  const sandboxes = active.filter(environment => environment.driver === "sandbox");
  const candidates = sandboxes.length ? sandboxes : active;
  if (candidates.length !== 1) {
    throw new SetupError(`The company has ${candidates.length} usable environments; pass --environment <id>`);
  }
  return String(candidates[0]!.id);
}

export const AGENT_INSTRUCTIONS = [
  "You are a load-test worker for a Paperclip scale ramp.",
  "Follow the assigned task literally and in order. Keep every reply short.",
  "Use only the runtime's real tool-call channel for tools. Never print tool-call markup as text.",
  "Never print, store or expose credential values. Never create other tasks, documents or agents.",
].join("\n");

export function agentPayload(input: { label: string; index: number; environmentId: string; profile: AgentProfile; secretId: string | null }): Json {
  const { profile } = input;
  const env = profile.credentialKey && input.secretId
    ? { [profile.credentialKey]: { type: "secret_ref", secretId: input.secretId, version: "latest" } }
    : {};
  return {
    name: agentName(input.label, input.index),
    role: "qa",
    title: "Scale ramp worker",
    capabilities: "Runs one small deterministic task at a time for a load test.",
    adapterType: "paperclip_runner",
    adapterConfig: {
      provider: profile.provider,
      model: profile.model,
      lifecycleMode: "warm",
      idleTimeoutMs: 300_000,
      ...(profile.provider === "opencode" ? { opencodePermissionMode: "allow" } : {}),
      env,
      ...profile.adapterOverrides,
    },
    defaultEnvironmentId: input.environmentId,
    budgetMonthlyCents: 0,
    runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } },
    instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": AGENT_INSTRUCTIONS } },
  };
}

export async function prepareCompany(input: {
  api: PaperclipClient;
  options: Options;
  state: RunState;
  store: StateStore;
  credential: string | null;
  log: (line: string) => void;
}): Promise<void> {
  const { api, options, state, store } = input;
  await resolveCompany(api, options, state, store);
  const companyId = state.companyId!;
  state.environmentId = await pickEnvironment(api, companyId, options.environmentId, options.target.kind === "local");
  await store.save(state);
  const profile = options.profile;
  if (profile.credentialKey && !profile.providerSecretId) {
    if (!input.credential) throw new SetupError(`Set ${profile.credentialKey} in the environment, or PAPERCLIP_SCALE_PROVIDER_SECRET_ID to reuse a stored secret`);
    const secret = await api.post<{ id: string }>(`/api/companies/${companyId}/secrets`, {
      name: `${secretPrefix(options.label)}${profile.credentialKey}`,
      value: input.credential,
      description: `Scale ramp ${options.label}; deleted at cleanup`,
    });
    state.secretId = String(secret.id);
    await store.save(state);
  }
  const project = await api.post<{ id: string }>(`/api/companies/${companyId}/projects`, {
    name: projectName(options.label),
    description: `Scale ramp ${options.label}. Created and archived by scripts/scale-agents-ramp.ts.`,
  });
  state.projectId = String(project.id);
  await store.save(state);
  input.log(`Prepared company ${companyId}: environment ${state.environmentId}, project ${state.projectId}`);
}

export async function ensureAgents(input: {
  api: PaperclipClient;
  options: Options;
  state: RunState;
  store: StateStore;
  count: number;
}): Promise<void> {
  const { api, options, state, store } = input;
  const secretId = options.profile.providerSecretId ?? state.secretId;
  const start = state.agentIds.length;
  const indices = Array.from({ length: Math.max(0, input.count - start) }, (_, offset) => start + offset);
  await mapLimit(indices, AGENT_CREATE_PARALLELISM, async index => {
    const created = await api.post<{ id: string }>(`/api/companies/${state.companyId}/agents`, agentPayload({
      label: options.label, index, environmentId: state.environmentId!, profile: options.profile, secretId,
    }));
    state.agentIds.push(String(created.id));
    await store.save(state);
  });
}

export const AGENT_CREATE_PARALLELISM = 8;
export const LIFECYCLE_ERROR_GRACE_MS = 60_000;
export const AGENT_LIST_FAILURE_LIMIT = 5;

export class AgentsNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentsNotReady";
  }
}

const NOT_INVOKABLE = new Set(["paused", "terminated", "pending_approval"]);

export function agentReady(agent: Json): boolean {
  if (agent.lifecycleState === "ready") return !NOT_INVOKABLE.has(String(agent.status));
  return agent.lifecycleState == null && ["idle", "active", "running", "error"].includes(String(agent.status));
}

export function describeAgent(agent: Json): string {
  const parts = [`agent ${agent.name ?? agent.id} is ${agent.status ?? "missing"}`];
  if (agent.lifecycleState) parts.push(`setup state ${agent.lifecycleState}`);
  if (agent.pauseReason) parts.push(`pause reason ${agent.pauseReason}`);
  if (Array.isArray(agent.lifecycleHolds) && agent.lifecycleHolds.length) parts.push(`holds ${agent.lifecycleHolds.join(", ")}`);
  const reason = agent.lifecycleError ?? agent.errorReason;
  return `${parts.join(", ")}; ${reason ? `Paperclip says: ${String(reason).slice(0, 400)}` : "Paperclip gave no reason"}`;
}

export async function waitForAgentsReady(input: {
  api: PaperclipClient;
  clock: Clock;
  companyId: string;
  agentIds: readonly string[];
  timeoutMs: number;
  pollMs: number;
  shouldStop: () => boolean;
  log: (line: string) => void;
  tick?: () => Promise<boolean>;
}): Promise<boolean> {
  const { api, clock } = input;
  const started = clock.now();
  const erroredSince = new Map<string, number>();
  let logged = false;
  let readFailures = 0;
  for (;;) {
    if (input.shouldStop()) return false;
    let listed: Json[];
    try {
      listed = await api.get<Json[]>(`/api/companies/${input.companyId}/agents`);
      readFailures = 0;
    } catch (error) {
      readFailures += 1;
      if (input.shouldStop()) return false;
      const message = error instanceof Error ? error.message : String(error);
      if (readFailures >= AGENT_LIST_FAILURE_LIMIT) {
        throw new AgentsNotReady(`the agent list could not be read ${readFailures} times in a row while waiting for agent setup: ${message.slice(0, 300)}`);
      }
      if (clock.now() - started >= input.timeoutMs) {
        throw new AgentsNotReady(`agent setup could not be checked within ${Math.round(input.timeoutMs / 60_000)} min: ${message.slice(0, 300)}`);
      }
      await clock.sleep(input.pollMs);
      continue;
    }
    const byId = new Map(listed.map(agent => [String(agent.id), agent]));
    const waiting = input.agentIds.map(id => byId.get(id) ?? { id, status: null }).filter(agent => !agentReady(agent));
    if (!waiting.length) {
      if (logged) input.log(`All ${input.agentIds.length} agents finished setup after ${Math.round((clock.now() - started) / 1_000)} s`);
      return true;
    }
    if (input.shouldStop() || await input.tick?.()) return false;
    const now = clock.now();
    for (const agent of waiting) {
      const id = String(agent.id);
      if (agent.lifecycleError) {
        if (!erroredSince.has(id)) erroredSince.set(id, now);
      } else erroredSince.delete(id);
    }
    const stuck = waiting.find(agent => now - (erroredSince.get(String(agent.id)) ?? now) >= LIFECYCLE_ERROR_GRACE_MS);
    if (stuck) {
      throw new AgentsNotReady(`${waiting.length} of ${input.agentIds.length} agents cannot finish setup: ${describeAgent(stuck)}`);
    }
    if (now - started >= input.timeoutMs) {
      throw new AgentsNotReady(`${waiting.length} of ${input.agentIds.length} agents did not finish setup within ${Math.round(input.timeoutMs / 60_000)} min: ${describeAgent(waiting[0]!)}`);
    }
    if (!logged) {
      input.log(`Waiting for ${waiting.length} agents to finish setup (${describeAgent(waiting[0]!)})`);
      logged = true;
    }
    await clock.sleep(input.pollMs);
  }
}
