/**
 * Config and aged-state fault waves (CF1–CF3). See config-faults.ts for the
 * oracle and README.md ("Config faults") for usage.
 *
 *   node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/config-wave.ts \
 *     --faults CF1,CF3 --adapters codex --tasks 4 --concurrency 1 --restarts K1,K2 --seed 61
 *
 * Each task gets its own agent, credential secret and project, so breaking
 * one task's setting never touches another task. The harness breaks the
 * setting through the board routes a user would use, launches an A1 brief
 * task, watches it rest, restarts the control plane while it is parked,
 * repairs the setting, uses the offered action, and grades the result.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { releaseInstance } from "../runner-e2e/instance-retention.js";
import { ChaosApi, ChaosApiError } from "./api.js";
import {
  CONFIG_FAULT_KINDS, CONFIG_REFERENCE_IDS, CONFIG_REFERENCES, CONFIG_REFERENCES_NOT_BROKEN, CONFIG_RESTART_KINDS,
  RestartGate, STALE_PROVISION_COMMAND, gradeConfigTask, isWriteRefusal, parkState, planConfigWave, validateConfigPlan,
  type ConfigGrade, type ConfigSnapshot, type ConfigTaskPlan, type ConfigTaskRecord, type ConfigWaveOptions,
} from "./config-faults.js";
import { CREDENTIAL_FOR_ADAPTER, waveIdFor } from "./config.js";
import { knownSecretValues, redactKnownSecrets } from "./evidence.js";
import { seedChaosLab, waitForAgentsReady, type ChaosLab } from "./seed.js";
import { ChaosSupervisor } from "./supervisor.js";
import { Timeline } from "./timeline.js";
import { guardedRunnerOutputs, worktreeFingerprint } from "./wave-guard.js";
import { ADAPTER_IDS } from "./types.js";
import { workloadDefinitions } from "./workloads.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const resultsRoot = path.resolve(process.env.RESTART_CHAOS_RESULTS_DIR ?? path.join(import.meta.dirname, "results"));
const POLL_MS = 4_000;
/** No run created for this long before a rest counts. */
const SETTLE_MS = 30_000;
/** After the restart, how long the task may take to rest again. */
const RESTART_REPARK_MS = 150_000;
type Json = Record<string, any>;

export function parseConfigWaveArgs(argv: readonly string[]): { options: ConfigWaveOptions; keep: boolean } {
  const { values } = parseArgs({ args: argv[0] === "--" ? argv.slice(1) : [...argv], strict: true, options: {
    faults: { type: "string" }, adapters: { type: "string" }, tasks: { type: "string" }, concurrency: { type: "string" },
    restarts: { type: "string" }, seed: { type: "string" }, references: { type: "string" },
    "park-seconds": { type: "string" }, "repair-seconds": { type: "string" }, keep: { type: "boolean" },
  } });
  const list = <T extends string>(raw: string | undefined, allowed: readonly T[], name: string, fallback: T[]): T[] => {
    if (raw === undefined) return fallback;
    const items = raw.split(",").map(item => item.trim()).filter(Boolean);
    for (const item of items) if (!allowed.includes(item as T)) throw new Error(`Unknown ${name} "${item}"; allowed: ${allowed.join(", ")}`);
    if (!items.length) throw new Error(`--${name} must not be empty`);
    return [...new Set(items)] as T[];
  };
  const int = (raw: string | undefined, name: string, fallback: number, min: number, max: number) => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer between ${min} and ${max}`);
    return value;
  };
  const options: ConfigWaveOptions = {
    faults: list(values.faults, CONFIG_FAULT_KINDS, "faults", ["CF1", "CF3"]),
    adapters: list(values.adapters, ADAPTER_IDS, "adapters", ["codex"]),
    tasks: int(values.tasks, "tasks", 2, 1, 4),
    // Disk and the one-wave-per-machine rule keep these waves small.
    concurrency: int(values.concurrency, "concurrency", 1, 1, 2),
    restarts: list(values.restarts, CONFIG_RESTART_KINDS, "restarts", ["K1", "K2"]),
    seed: int(values.seed, "seed", Date.now() % 100_000, 0, 2 ** 31 - 1),
    ...(values.references ? { references: list(values.references, CONFIG_REFERENCE_IDS, "references", []) } : {}),
    parkBoundMs: int(values["park-seconds"], "park-seconds", 420, 60, 1_800) * 1_000,
    repairBudgetMs: int(values["repair-seconds"], "repair-seconds", 900, 120, 3_600) * 1_000,
  };
  return { options, keep: values.keep === true };
}

function preflight(tasks: readonly ConfigTaskPlan[]) {
  const missing = [...new Set(tasks.map(task => CREDENTIAL_FOR_ADAPTER[task.adapter]))].filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing credentials ${missing.join(", ")}. Run: set -a; source ~/.secrets; set +a`);
  const runner = process.env.PAPERCLIP_RUNNER_BINARY ?? path.join(repositoryRoot, "packages/paperclip-runner/runner/target/debug/paperclip-runnerd");
  if (!existsSync(runner)) throw new Error(`Runner binary missing at ${runner}. Run: node scripts/agent-preflight.mjs`);
  const build = spawnSync(process.execPath, [path.join(repositoryRoot, "packages/paperclip-runner/scripts/build-verified-provider-entrypoints.mjs")],
    { cwd: repositoryRoot, stdio: "inherit" });
  if (build.status !== 0) throw new Error("Verified provider entrypoint build failed");
}

/** A task's own agent, credential and project: the objects its broken setting refers to. */
interface TaskResources {
  agentId: string;
  agentBody: Json;
  credentialKey: string;
  secretId: string | null;
  projectId: string;
  workspaceId: string;
  basePolicy: Json;
  /** CF2 repair: the OpenRouter account the harness connected. */
  connectionId?: string;
}

function basePolicy(lab: ChaosLab): Json {
  return { enabled: true, defaultMode: "isolated_workspace", allowIssueOverride: false, environmentId: lab.environmentId,
    workspaceStrategy: { type: "git_worktree" } };
}

const secretRef = (secretId: string) => ({ type: "secret_ref", secretId, version: "latest" });

async function createTaskResources(api: ChaosApi, lab: ChaosLab, task: ConfigTaskPlan, timeline: Timeline): Promise<TaskResources> {
  const source = lab.agents[task.adapter]?.body;
  if (!source) throw new Error(`Seeded lab has no ${task.adapter} agent body to clone`);
  const credentialKey = CREDENTIAL_FOR_ADAPTER[task.adapter];
  const adapterConfig = { ...((source.adapterConfig ?? {}) as Json) };
  const env = { ...((adapterConfig.env ?? {}) as Json) };
  const runtimeConfig = { ...((source.runtimeConfig ?? {}) as Json) };
  let secretId: string | null = null;
  if (task.reference === "ai_default") {
    // The responsible user's personal default; the fresh company has no OpenRouter account at all.
    delete env[credentialKey];
    runtimeConfig.aiConnection = { provider: "openrouter", method: "api_key", mode: "responsible_user" };
  } else {
    const secret = await api.post<{ id: string }>(`/api/companies/${lab.companyId}/secrets`, {
      // Secret keys are unique per company; the agent's env var name stays the provider's.
      name: `Chaos ${credentialKey} ${task.taskId}-${task.nonce}`, key: `${credentialKey}_${task.taskId}_${task.nonce}`, value: process.env[credentialKey],
      description: `Restart chaos config fault ${task.taskId}` });
    secretId = secret.id;
    env[credentialKey] = secretRef(secret.id);
  }
  const agentBody: Json = { ...source, name: `Chaos ${task.adapter} ${task.taskId}`, adapterConfig: { ...adapterConfig, env }, runtimeConfig };
  const agent = await api.post<{ id: string }>(`/api/companies/${lab.companyId}/agents`, agentBody);
  const policy = basePolicy(lab);
  const project = await api.post<{ id: string }>(`/api/companies/${lab.companyId}/projects`, {
    name: `cf-${task.taskId}-${task.nonce}`, description: `Restart chaos config fault ${task.fault}/${task.reference}`,
    executionWorkspacePolicy: policy,
    workspace: { name: "Primary", sourceType: "local_path", cwd: lab.fixtureRepositoryPath, isPrimary: true },
  });
  const full = await api.get<Json>(`/api/projects/${project.id}`);
  const workspaceId = full.primaryWorkspace?.id ?? full.workspaces?.[0]?.id;
  if (!workspaceId) throw new Error(`Project ${project.id} has no primary workspace`);
  timeline.add("cf_task_resources", { taskId: task.taskId, agentId: agent.id, projectId: project.id, workspaceId, secretId });
  return { agentId: agent.id, agentBody, credentialKey, secretId, projectId: project.id, workspaceId, basePolicy: policy };
}

/** Break the task's reference through the board routes. Returns a refusal when the server rejected the stale value on write. */
async function breakReference(api: ChaosApi, lab: ChaosLab, task: ConfigTaskPlan, resources: TaskResources): Promise<string | null> {
  try {
    switch (task.reference) {
      case "provision_command":
        await api.patch(`/api/projects/${resources.projectId}`, { executionWorkspacePolicy: { ...resources.basePolicy,
          workspaceStrategy: { type: "git_worktree", provisionCommand: STALE_PROVISION_COMMAND } } });
        return null;
      case "base_ref":
        await api.patch(`/api/projects/${resources.projectId}`, { executionWorkspacePolicy: { ...resources.basePolicy,
          workspaceStrategy: { type: "git_worktree", baseRef: `chaos-missing-ref-${task.nonce}` } } });
        return null;
      case "workspace_cwd":
        await api.patch(`/api/projects/${resources.projectId}/workspaces/${resources.workspaceId}`,
          { cwd: path.join(path.dirname(lab.fixtureRepositoryPath), `chaos-missing-${task.nonce}`) });
        return null;
      case "agent_secret":
        await api.delete(`/api/secrets/${resources.secretId}`);
        return null;
      case "model_id":
        await api.patch(`/api/agents/${resources.agentId}`, { adapterConfig: { model: `chaos-missing-model-${task.nonce}` } });
        return null;
      case "ai_default":
        // Broken at creation: the binding selects a personal default the company never had.
        return null;
    }
  } catch (error) {
    // Only a validation refusal proves the product rejects the stale value; a 403, 404 or 429 is a harness failure.
    if (error instanceof ChaosApiError && isWriteRefusal(error.status)) return error.message.slice(0, 400);
    throw error;
  }
}

/** Put the setting back the way a user would. */
async function repairReference(api: ChaosApi, lab: ChaosLab, task: ConfigTaskPlan, resources: TaskResources): Promise<string> {
  switch (task.reference) {
    case "provision_command":
    case "base_ref":
      await api.patch(`/api/projects/${resources.projectId}`, { executionWorkspacePolicy: resources.basePolicy });
      return "restored the project workspace policy without the stale value";
    case "workspace_cwd":
      await api.patch(`/api/projects/${resources.projectId}/workspaces/${resources.workspaceId}`, { cwd: lab.fixtureRepositoryPath });
      return "restored the project workspace path";
    case "agent_secret": {
      const secret = await api.post<{ id: string }>(`/api/companies/${lab.companyId}/secrets`, {
        name: `Chaos ${resources.credentialKey} ${task.taskId}-${task.nonce} repaired`, key: `${resources.credentialKey}_${task.taskId}_${task.nonce}_repaired`,
        value: process.env[resources.credentialKey], description: "Restart chaos config fault repair" });
      await api.patch(`/api/agents/${resources.agentId}`, { adapterConfig: { env: { [resources.credentialKey]: secretRef(secret.id) } } });
      return "created a new secret and pointed the agent at it";
    }
    case "model_id":
      await api.patch(`/api/agents/${resources.agentId}`, { adapterConfig: { model: resources.agentBody.adapterConfig?.model } });
      return `restored model ${String(resources.agentBody.adapterConfig?.model)}`;
    case "ai_default": {
      const created = await api.post<{ connectionId: string; grantId: string }>(`/api/companies/${lab.companyId}/ai-connections`, {
        provider: "openrouter", method: "api_key", name: `Chaos OpenRouter ${task.nonce}`, ownership: "personal",
        // The account must be installed for the agent; without it selection refuses "not permitted for this agent".
        apiKey: process.env.OPENROUTER_API_KEY, agentIds: [resources.agentId], allAgents: false }, 60_000);
      resources.connectionId = created.connectionId;
      return "connected a personal OpenRouter account for the agent (it becomes the default)";
    }
  }
}

async function snapshot(api: ChaosApi, issueId: string, agentId: string, errors: Map<string, string | null>): Promise<ConfigSnapshot> {
  const at = Date.now();
  try {
    const [issue, runs, execution, interactions, agent, comments] = await Promise.all([
      api.get<Json>(`/api/issues/${issueId}`, 5_000),
      api.get<Json[]>(`/api/issues/${issueId}/runs`, 5_000),
      api.get<Json | null>(`/api/issues/${issueId}/execution`, 5_000).catch(() => null),
      api.get<Json[]>(`/api/issues/${issueId}/interactions`, 5_000).catch(() => []),
      api.get<Json>(`/api/agents/${agentId}`, 5_000).catch(() => null),
      api.get<Json[]>(`/api/issues/${issueId}/comments`, 5_000).catch(() => []),
    ]);
    const runSamples: ConfigSnapshot["runs"] = [];
    for (const run of runs ?? []) {
      const id = String(run.runId ?? run.id);
      const status = String(run.status);
      let error: string | null = typeof run.error === "string" ? run.error : null;
      if (!error && !["queued", "running"].includes(status)) {
        if (!errors.has(id)) errors.set(id, await api.get<Json>(`/api/heartbeat-runs/${id}`, 5_000).then(row => row?.error ?? null).catch(() => null));
        error = errors.get(id) ?? null;
      }
      runSamples.push({ id, status, createdAt: time(run.createdAt), startedAt: time(run.startedAt), errorCode: run.errorCode ?? null, error });
    }
    const interruption = issue.interruption as Json | null | undefined;
    const projection = (execution?.execution ?? null) as Json | null;
    return {
      at, reachable: true, issueStatus: String(issue.status), runs: runSamples,
      interruption: interruption ? { state: interruption.state ?? null, canRetry: interruption.canRetry === true, userAction: interruption.userAction ?? null,
        workspaceFailure: interruption.workspaceFailure?.message ?? null, setupFailure: interruption.setupFailure?.message ?? null,
        rejectedModel: interruption.rejectedModel ?? null, observedRunId: interruption.observedRunId ?? null } : null,
      execution: projection ? { label: projection.label ?? null, cause: projection.cause ?? null, nextAction: projection.nextAction ?? null } : null,
      cards: (Array.isArray(interactions) ? interactions : []).map(card => ({ id: String(card.id), kind: String(card.kind), status: String(card.status),
        serviceSlug: card.payload?.serviceSlug ?? null, agentSetup: card.payload?.agentSetup === true })),
      agent: agent ? { lifecycleState: agent.lifecycleState ?? null, lifecycleError: agent.lifecycleError ?? null,
        // The agent response redacts lifecycleOperation; parked setup also says so in its message.
        retryRequired: agent.lifecycleOperation?.retryRequired === true
          || /automatic verification is paused|choose retry now/i.test(String(agent.lifecycleError ?? "")) } : null,
      notices: (Array.isArray(comments) ? comments : []).filter(comment => !comment.authorAgentId).map(comment => String(comment.body ?? "")).slice(-5),
    };
  } catch {
    return { at, reachable: false, issueStatus: null, runs: [], interruption: null, execution: null, cards: [], agent: null, notices: [] };
  }
}

function time(value: unknown): number | null {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/** Use what the task offers: complete a pending connection card, then Retry (the task's, or a rejected model's marker), then the agent's setup Retry. */
async function offeredAction(api: ChaosApi, record: ConfigTaskRecord, resources: TaskResources, current: ConfigSnapshot): Promise<string> {
  const card = current.cards.find(candidate => candidate.status === "pending" && candidate.kind === "connection_intent");
  if (card && resources.connectionId) {
    await api.post(`/api/connection-intents/${card.id}/complete`, { connectionId: resources.connectionId });
    return `completed connection card ${card.id}`;
  }
  if (current.interruption?.canRetry && current.interruption.observedRunId) {
    const response = await api.post<Json>(`/api/issues/${record.issueId}/retry`, { idempotencyKey: randomUUID(), observedRunId: current.interruption.observedRunId });
    return `clicked Retry (accepted=${String(response?.accepted)})`;
  }
  // A rejected model offers Retry on the run's "Model unavailable" marker, which retries that run on the agent.
  if (current.interruption?.userAction === "choose_model" && current.interruption.observedRunId) {
    const response = await api.post<Json>(`/api/agents/${resources.agentId}/wakeup`, { source: "on_demand", triggerDetail: "manual",
      reason: "retry_failed_run", failedRunId: current.interruption.observedRunId });
    return `clicked the model marker's Retry (run ${String(response?.id ?? "none")})`;
  }
  if (current.agent && current.agent.lifecycleState !== "ready") {
    await api.post(`/api/agents/${resources.agentId}/lifecycle/retry`, {});
    return `agent setup Retry (lifecycle ${current.agent.lifecycleState})`;
  }
  return "no offered action; waited";
}

/** Set by SIGINT/SIGTERM: tasks stop at their next step and the wave still reaches cleanup. */
let interrupted = false;
function checkInterrupted() {
  if (interrupted) throw new Error("interrupted");
}

interface TaskInput {
  api: ChaosApi; lab: ChaosLab; task: ConfigTaskPlan; supervisor: ChaosSupervisor; timeline: Timeline;
  options: ConfigWaveOptions; gate: RestartGate; onRestart: (faultId: string) => void;
}

async function runTask(input: TaskInput): Promise<ConfigTaskRecord> {
  const { api, lab, task, timeline, gate } = input;
  const record: ConfigTaskRecord = { plan: task, issueId: null, agentId: null, projectId: null, launchedAt: null, refusedOnWrite: null,
    harnessError: null, brokenSnapshots: [], parkedAt: null, parkReason: null, restart: null, afterRestartSnapshots: [], afterRestartParked: null,
    repair: null, doneAt: null, finalStatus: null, brief: null };
  const errors = new Map<string, string | null>();
  let resources: TaskResources;
  try {
    checkInterrupted();
    resources = await gate.write(() => createTaskResources(api, lab, task, timeline));
    record.agentId = resources.agentId;
    record.projectId = resources.projectId;
    // A working agent first, so the only broken thing is the setting under test (CF2's agent cannot verify by design).
    if (task.reference !== "ai_default") {
      await waitForAgentsReady(api, { [task.taskId]: { id: resources.agentId } }, timeline, undefined, 1_000, () => interrupted);
    }
    checkInterrupted();
    record.refusedOnWrite = await gate.write(() => breakReference(api, lab, task, resources));
    timeline.add("cf_broken", { taskId: task.taskId, fault: task.fault, reference: task.reference, refusedOnWrite: record.refusedOnWrite });
    if (record.refusedOnWrite) return record;
    const a1 = workloadDefinitions.A1;
    const issue = await gate.write(() => api.post<Json>(`/api/companies/${lab.companyId}/issues`, {
      title: `Chaos ${task.fault} ${task.reference} ${task.nonce}`, description: a1.description(task.nonce), status: "todo", priority: "medium",
      assigneeAgentId: resources.agentId, projectId: resources.projectId }));
    record.issueId = String(issue.id);
    record.launchedAt = Date.now();
    timeline.add("cf_launched", { taskId: task.taskId, issueId: issue.id, identifier: issue.identifier ?? null });
  } catch (error) {
    record.harnessError = `setup: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600);
    return record;
  }
  try {
    await observeTask(input, record, resources, errors);
  } catch (error) {
    record.harnessError = (error instanceof Error ? error.message : String(error)).slice(0, 600);
  }
  return record;
}

async function observeTask(input: TaskInput, record: ConfigTaskRecord, resources: TaskResources, errors: Map<string, string | null>): Promise<void> {
  const { api, lab, task, supervisor, timeline, options, gate } = input;
  const issueId = record.issueId!;

  // Broken phase: until done, parked (stable across two polls) or the bound.
  let parkedCandidate: number | null = null;
  while (Date.now() - record.launchedAt! < options.parkBoundMs) {
    await delay(POLL_MS);
    checkInterrupted();
    if (!supervisor.serverReady) continue;
    const current = await snapshot(api, issueId, resources.agentId, errors);
    record.brokenSnapshots.push(current);
    if (!current.reachable) continue;
    const state = parkState(current, current.at, SETTLE_MS);
    if (state.kind === "done") break;
    if (state.kind === "parked") {
      parkedCandidate ??= current.at;
      if (current.at - parkedCandidate >= 2 * POLL_MS) { record.parkedAt = parkedCandidate; record.parkReason = state.reason; break; }
    } else parkedCandidate = null;
  }
  timeline.add("cf_broken_phase_end", { taskId: task.taskId, parkedAt: record.parkedAt, parkReason: record.parkReason,
    lastStatus: record.brokenSnapshots.at(-1)?.issueStatus ?? null });

  const completedWhileBroken = record.brokenSnapshots.at(-1)?.issueStatus === "done";
  if (!completedWhileBroken) {
    // Restart while parked (or at the bound). The gate holds every task's writes while the server is down.
    checkInterrupted();
    await gate.restart(async () => {
      const restart: NonNullable<ConfigTaskRecord["restart"]> = { kind: task.restart, faultId: null, firedAt: Date.now(), readyAt: null, error: null };
      record.restart = restart;
      try {
        const receipt = await supervisor.fault(task.restart, 0, task.taskId);
        restart.faultId = receipt.faultId;
        restart.readyAt = receipt.readyAt;
        restart.error = receipt.error;
        input.onRestart(receipt.faultId);
      } catch (error) {
        restart.error = error instanceof Error ? error.message : String(error);
      }
    });
    // After the restart: the task must rest again, still naming the setting.
    const repark = Date.now();
    let lastParked: number | null = null;
    while (Date.now() - repark < RESTART_REPARK_MS) {
      await delay(POLL_MS);
      checkInterrupted();
      if (!supervisor.serverReady) continue;
      const current = await snapshot(api, issueId, resources.agentId, errors);
      if (!current.reachable) continue;
      record.afterRestartSnapshots.push(current);
      const state = parkState(current, current.at, SETTLE_MS);
      if (state.kind === "done") { record.afterRestartParked = true; break; }
      if (state.kind === "parked") {
        lastParked ??= current.at;
        if (current.at - lastParked >= 2 * POLL_MS) { record.afterRestartParked = true; break; }
      } else lastParked = null;
    }
    record.afterRestartParked ??= false;
    timeline.add("cf_after_restart", { taskId: task.taskId, restart: record.restart, parkedAgain: record.afterRestartParked });

    // Repair, then the offered action.
    checkInterrupted();
    const repairAt = Date.now();
    try {
      const { detail, action } = await gate.write(async () => {
        const detail = await repairReference(api, lab, task, resources);
        await delay(3_000);
        const current = await snapshot(api, issueId, resources.agentId, errors);
        const action = current.issueStatus === "done" ? "none (already done)" : await offeredAction(api, record, resources, current);
        return { detail, action };
      });
      record.repair = { at: repairAt, action, detail, error: null };
    } catch (error) {
      record.repair = { at: repairAt, action: "repair", detail: "", error: error instanceof Error ? error.message.slice(0, 400) : String(error) };
    }
    timeline.add("cf_repaired", { taskId: task.taskId, repair: record.repair });
  }

  // Completion after repair, bounded.
  const deadline = Date.now() + options.repairBudgetMs;
  while (Date.now() < deadline) {
    checkInterrupted();
    const current = await snapshot(api, issueId, resources.agentId, errors);
    if (current.reachable) {
      record.finalStatus = current.issueStatus;
      record.afterRepair = current;
      if (current.issueStatus === "done") { record.doneAt = Date.now(); break; }
    }
    await delay(POLL_MS * 2);
  }
  const brief = await api.get<Json>(`/api/issues/${issueId}/documents/brief`).then(row => typeof row?.body === "string" ? row.body : null).catch(() => null);
  const oracle = workloadDefinitions.A1.grade(task.nonce, { issueStatus: record.finalStatus, documents: { brief }, agentComments: [], files: {}, commands: {}, workspacePath: null });
  record.brief = { ok: oracle.verdict === "pass", detail: oracle.checks.filter(check => !check.ok).map(check => `${check.name}${check.detail ? ` (${check.detail})` : ""}`).join("; ") || "brief ok" };
}

export function configSummaryMarkdown(waveId: string, gitSha: string, rows: Array<{ record: ConfigTaskRecord; grade: ConfigGrade }>): string {
  const lines = [`# Config fault wave ${waveId}`, "", `Commit ${gitSha}`, "",
    "| Task | Fault | Setting | Adapter | Restart | Outcome | Pass | Signature |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const { record, grade } of rows) {
    lines.push(`| ${record.plan.taskId} | ${record.plan.fault} | ${record.plan.reference} | ${record.plan.adapter} | ${record.plan.restart} | ${grade.outcome} | ${grade.pass ? "pass" : "FAIL"} | ${grade.signature ?? ""} |`);
  }
  lines.push("", "## Checks", "");
  for (const { record, grade } of rows) {
    lines.push(`### ${record.plan.taskId} ${record.plan.fault}/${record.plan.reference}: ${CONFIG_REFERENCES[record.plan.reference].label}`, "");
    for (const check of grade.checks) lines.push(`- ${check.verdict === "pass" ? "pass" : check.verdict === "n/a" ? "n/a " : "FAIL"} ${check.name}: ${check.detail}`);
    lines.push("");
  }
  lines.push("## Not broken by CF3", "", ...Object.entries(CONFIG_REFERENCES_NOT_BROKEN).map(([name, why]) => `- ${name}: ${why}`), "");
  return lines.join("\n");
}

async function main(): Promise<number> {
  const { options, keep } = parseConfigWaveArgs(process.argv.slice(2));
  const tasks = planConfigWave(options);
  validateConfigPlan(tasks);
  const waveId = `${waveIdFor(options.seed)}-cf`;
  const waveDir = path.join(resultsRoot, waveId);
  await mkdir(waveDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(waveDir, "config-plan.json"), `${JSON.stringify({ waveId, options, tasks }, null, 2)}\n`, { mode: 0o600 });
  const timeline = new Timeline(path.join(waveDir, "timeline.jsonl"));
  const gitSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
  timeline.add("cf_wave_planned", { waveId, gitSha, tasks: tasks.map(task => `${task.taskId}:${task.adapter}/${task.fault}/${task.reference}/${task.restart}`) });
  preflight(tasks);
  // Every restart re-runs the server from this checkout: a build or checkout change mid-wave would mix builds.
  const guardedOutputs = guardedRunnerOutputs(repositoryRoot);
  const startFingerprint = worktreeFingerprint(repositoryRoot, guardedOutputs);
  let worktreeChangedAt: string | null = null;
  const checkWorktree = (at: string) => {
    if (worktreeChangedAt || worktreeFingerprint(repositoryRoot, guardedOutputs) === startFingerprint) return;
    worktreeChangedAt = at;
    timeline.add("worktree_changed_mid_wave", { at });
  };
  const onSignal = (signal: NodeJS.Signals) => { if (!interrupted) { interrupted = true; timeline.add("harness_interrupted", { signal }); } };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const supervisor = await ChaosSupervisor.create({ repositoryRoot, waveDir, timeline });
  let stopFailed = false;
  let harnessError: unknown = null;
  const rows: Array<{ record: ConfigTaskRecord; grade: ConfigGrade }> = [];
  try {
    await supervisor.start({});
    const api = new ChaosApi(supervisor.baseUrl);
    const lab = await seedChaosLab({ api, env: "local", waitForReadyAgents: true, adapters: [...new Set(tasks.map(task => task.adapter))],
      concurrency: options.concurrency, budgetCents: 3_000, fixtureRoot: path.join(supervisor.paths.temporaryRoot, "fixtures"), waveId, timeline });
    const gate = new RestartGate();
    const pending = [...tasks];
    const records: ConfigTaskRecord[] = [];
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
      while (pending.length && !interrupted) {
        const task = pending.shift()!;
        records.push(await runTask({ api, lab, task, supervisor, timeline, options, gate, onRestart: checkWorktree }));
      }
    }));
    checkWorktree("wave_end");
    if (worktreeChangedAt) throw new Error(`The worktree changed during the wave (first seen after ${worktreeChangedAt}); later restarts may have run different code`);
    if (interrupted) throw new Error("Harness interrupted before the wave finished");
    for (const record of records.sort((left, right) => left.plan.index - right.plan.index)) {
      const grade = gradeConfigTask(record, { parkBoundMs: options.parkBoundMs });
      rows.push({ record, grade });
      await writeFile(path.join(waveDir, `${record.plan.taskId}.config-grade.json`),
        `${redactKnownSecrets(JSON.stringify({ record, grade }, null, 2), knownSecretValues())}\n`, { mode: 0o600 });
      timeline.add("cf_task_graded", { taskId: record.plan.taskId, pass: grade.pass, outcome: grade.outcome, signature: grade.signature });
    }
  } catch (error) {
    harnessError = error;
    timeline.add("harness_error", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  } finally {
    try { await supervisor.stop(); } catch (error) { stopFailed = true; harnessError ??= error; }
    await releaseInstance(supervisor.paths.temporaryRoot, { keep, stopFailed, owner: waveId })
      .catch(error => timeline.add("instance_cleanup_failed", { error: String(error) }));
  }
  const summary = configSummaryMarkdown(waveId, gitSha, rows);
  await writeFile(path.join(waveDir, "SUMMARY.md"), summary, { mode: 0o600 });
  console.info(`\n${summary}\nWave ${waveId}: results ${waveDir}`);
  if (harnessError) { console.error(harnessError); return 2; }
  return rows.every(row => row.grade.pass) && rows.length === tasks.length ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main().catch(error => { console.error(error); return 2; }));
}
