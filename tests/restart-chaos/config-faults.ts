/**
 * Config and aged-state fault family (CF*): pure catalog, seeded plan and oracle.
 *
 * A fresh chaos instance only ever has valid settings. Production also has
 * saved settings that point at something that no longer exists (a renamed
 * setup script, an account default that was never chosen, a deleted secret).
 * Each CF task breaks one such reference on its own agent or project, and the
 * oracle is not "the task completes". It is:
 *
 *   1. within a bound the task completes, or rests where the user sees a
 *      specific message that names the broken setting (task-level surfaces);
 *   2. no run retries unchanged configuration forever, and nothing sits
 *      Queued with no live owner and no named wait;
 *   3. the parked state survives a K1/K2 restart;
 *   4. after the harness repairs the setting and uses the offered action
 *      (complete the connection card, Retry), the task completes.
 *
 * I/O lives in config-wave.ts; this file is credential-free and unit tested.
 */
import { createRng } from "./scheduler.js";
import type { AdapterId } from "./types.js";

export const CONFIG_FAULT_KINDS = ["CF1", "CF2", "CF3"] as const;
export type ConfigFaultKind = (typeof CONFIG_FAULT_KINDS)[number];
export const CONFIG_RESTART_KINDS = ["K1", "K2"] as const;
export type ConfigRestartKind = (typeof CONFIG_RESTART_KINDS)[number];

/** A saved setting that refers to another object, and how a user would recognise a message about it. */
export interface ConfigReference {
  id: ConfigReferenceId;
  owner: "agent" | "project";
  /** Field path as a user or the API names it. */
  field: string;
  refersTo: "script" | "account_default" | "credential" | "workspace_path" | "git_ref" | "model";
  /** Adapters whose agents carry this setting; absent means every adapter. */
  adapters?: readonly AdapterId[];
  /** An actionable message names this setting (case-insensitive). The nonce placeholder is filled per task. */
  names: (nonce: string) => RegExp;
  label: string;
}

export const CONFIG_REFERENCE_IDS = ["provision_command", "ai_default", "agent_secret", "workspace_cwd", "base_ref", "model_id"] as const;
export type ConfigReferenceId = (typeof CONFIG_REFERENCE_IDS)[number];

/** The stale setup script CF1 points at: the path #20269 renamed in the Paperclip repository. */
export const STALE_PROVISION_COMMAND = "bash ./scripts/provision-worktree.sh";

export const CONFIG_REFERENCES: Record<ConfigReferenceId, ConfigReference> = {
  provision_command: {
    id: "provision_command", owner: "project", field: "executionWorkspacePolicy.workspaceStrategy.provisionCommand",
    refersTo: "script", label: "Project workspace setup command points at a missing script",
    names: () => /provision-worktree\.sh|(setup|provision) command/i,
  },
  ai_default: {
    id: "ai_default", owner: "agent", field: "runtimeConfig.aiConnection (responsible_user default)",
    refersTo: "account_default", adapters: ["opencode"], label: "OpenRouter binding selects a personal account default that does not exist",
    names: () => /openrouter|personal default|connect (an |your )?(ai )?account/i,
  },
  agent_secret: {
    id: "agent_secret", owner: "agent", field: "adapterConfig.env.<provider key> (secret_ref)",
    refersTo: "credential", label: "Agent credential secret was deleted",
    names: nonce => new RegExp(`\\bsecret\\b|[A-Z]+_API_KEY|_${nonce}\\b`, "i"),
  },
  workspace_cwd: {
    id: "workspace_cwd", owner: "project", field: "project workspace cwd",
    refersTo: "workspace_path", label: "Project workspace path no longer exists",
    names: nonce => new RegExp(`project workspace|workspace path|workspace folder|chaos-missing-${nonce}`, "i"),
  },
  base_ref: {
    id: "base_ref", owner: "project", field: "executionWorkspacePolicy.workspaceStrategy.baseRef",
    refersTo: "git_ref", label: "Worktree base ref names a branch that no longer exists",
    names: nonce => new RegExp(`base ref|base branch|chaos-missing-ref-${nonce}`, "i"),
  },
  model_id: {
    id: "model_id", owner: "agent", field: "adapterConfig.model",
    refersTo: "model", label: "Agent model id no longer exists",
    names: nonce => new RegExp(`chaos-missing-model-${nonce}|choose_model|(unknown|unsupported|invalid|unavailable) model|model[^.]{0,40}(not found|unknown|unsupported|does not exist|not available|rejected)`, "i"),
  },
};

/**
 * Settings that reference another object but that CF3 does not break, and why.
 * Reported with every wave so the coverage gap stays visible.
 */
export const CONFIG_REFERENCES_NOT_BROKEN: Record<string, string> = {
  "agent skills (paperclipSkillSync.desiredSkills)": "deleting a skill an agent uses is refused (422) and unknown keys are rejected on write",
  "agent defaultEnvironmentId": "the FK is ON DELETE SET NULL and an instance has one local environment, so a local wave cannot leave it dangling",
  "project executionWorkspacePolicy.environmentId": "not read when choosing a run's environment, so breaking it changes nothing",
  "agent instructionsFilePath": "native runner agents use an instructions bundle; a missing file is only a warning for local adapters",
  "agent adapterConfig.cwd": "created on demand; project tasks use the execution workspace instead",
};

/** Which references a CF kind may break for an adapter. */
export function referencesFor(kind: ConfigFaultKind, adapter: AdapterId): ConfigReferenceId[] {
  if (kind === "CF1") return ["provision_command"];
  if (kind === "CF2") return ["ai_default"];
  return CONFIG_REFERENCE_IDS.filter(id => !CONFIG_REFERENCES[id].adapters || CONFIG_REFERENCES[id].adapters!.includes(adapter));
}

export interface ConfigTaskPlan {
  taskId: string;
  index: number;
  fault: ConfigFaultKind;
  reference: ConfigReferenceId;
  adapter: AdapterId;
  /** Restart fired while the task is parked (or at the park bound when it never parks). */
  restart: ConfigRestartKind;
  nonce: string;
}

export interface ConfigWaveOptions {
  seed: number;
  faults: ConfigFaultKind[];
  adapters: AdapterId[];
  tasks: number;
  concurrency: number;
  restarts: ConfigRestartKind[];
  /** CF3 only: break exactly these references, in turn (default: seeded over every applicable reference). */
  references?: ConfigReferenceId[];
  parkBoundMs: number;
  repairBudgetMs: number;
}

/**
 * Seeded plan. CF2's reference lives on an OpenCode agent, so CF2 tasks always
 * use the opencode adapter. CF3 walks a seeded shuffle of the applicable
 * references so a small wave still covers distinct settings.
 */
export function planConfigWave(options: ConfigWaveOptions): ConfigTaskPlan[] {
  const rng = createRng(options.seed ^ 0x0cf0cf);
  const tasks: ConfigTaskPlan[] = [];
  const cf3Queue: Partial<Record<AdapterId, ConfigReferenceId[]>> = {};
  for (let index = 0; index < options.tasks; index += 1) {
    const fault = options.faults[index % options.faults.length]!;
    const adapter: AdapterId = fault === "CF2" ? "opencode" : options.adapters[index % options.adapters.length]!;
    let reference: ConfigReferenceId;
    if (fault === "CF3") {
      const allowed = referencesFor("CF3", adapter).filter(id => !options.references || options.references.includes(id));
      if (!allowed.length) throw new Error(`CF3 has no reference to break for adapter ${adapter}`);
      let queue = cf3Queue[adapter];
      if (!queue?.length) queue = cf3Queue[adapter] = rng.shuffle(allowed);
      reference = queue.shift()!;
    } else {
      reference = referencesFor(fault, adapter)[0]!;
    }
    tasks.push({ taskId: `t${String(index + 1).padStart(2, "0")}`, index, fault, reference, adapter,
      // Alternate restart kinds per fault kind, so two tasks of one fault cross both K1 and K2.
      restart: options.restarts[tasks.filter(earlier => earlier.fault === fault).length % options.restarts.length]!, nonce: rng.hex(8) });
  }
  return tasks;
}

/**
 * The responsible user's account default is company-wide: once one task's
 * repair connects an account, a later task's binding is no longer broken, and
 * the product has no route to clear a default. One ai_default task per wave.
 */
export function validateConfigPlan(tasks: readonly ConfigTaskPlan[]): void {
  const aiDefault = tasks.filter(task => task.reference === "ai_default");
  if (aiDefault.length > 1) {
    throw new Error(`Only one ai_default (CF2) task fits in a wave; got ${aiDefault.map(task => task.taskId).join(", ")}. Lower --tasks or use --references.`);
  }
}

/** One poll of everything a user could see about the task, plus run state. */
export interface ConfigSnapshot {
  at: number;
  reachable: boolean;
  issueStatus: string | null;
  runs: Array<{ id: string; status: string; createdAt: number | null; startedAt: number | null; errorCode: string | null; error: string | null }>;
  interruption: { state: string | null; canRetry: boolean; userAction: string | null; workspaceFailure: string | null; observedRunId: string | null } | null;
  execution: { label: string | null; cause: string | null; nextAction: string | null } | null;
  /** Pending thread interactions on the task (connection cards and similar). */
  cards: Array<{ id: string; kind: string; status: string; serviceSlug: string | null; agentSetup: boolean }>;
  agent: { lifecycleState: string | null; lifecycleError: string | null; retryRequired: boolean } | null;
  /** Non-agent comments on the task (recovery notices). */
  notices: string[];
}

/** Text a user sees on the task page: the interruption, the execution status, cards, agent setup status and notices. */
export function taskLevelTexts(snapshot: ConfigSnapshot): string[] {
  const texts: string[] = [];
  const interruption = snapshot.interruption;
  if (interruption?.workspaceFailure) texts.push(interruption.workspaceFailure);
  if (interruption?.userAction) texts.push(`userAction:${interruption.userAction}`);
  if (snapshot.execution?.label) texts.push(snapshot.execution.label);
  if (snapshot.execution?.nextAction) texts.push(snapshot.execution.nextAction);
  for (const card of snapshot.cards) {
    if (card.status !== "pending") continue;
    texts.push(card.kind === "connection_intent" ? `Connect ${card.serviceSlug ?? "an account"}${card.agentSetup ? " (agent setup)" : ""}` : card.kind);
  }
  if (snapshot.agent?.lifecycleError) texts.push(snapshot.agent.lifecycleError);
  texts.push(...snapshot.notices);
  return texts;
}

/** Run error text: visible only on the run's own page, not on the task. */
export function runDetailTexts(snapshot: ConfigSnapshot): string[] {
  return snapshot.runs.flatMap(run => run.error ? [run.error] : []);
}

export function namingTexts(texts: readonly string[], pattern: RegExp): string[] {
  return texts.filter(text => pattern.test(text));
}

export type ParkState =
  | { kind: "done" }
  | { kind: "active"; reason: string }
  | { kind: "parked"; reason: string };

/**
 * Whether the task rests. A rest needs no running run, no run created in the
 * last `settleMs`, and something on the task that waits on a person: a pending
 * card, an interruption offering Retry or a user action, an agent whose setup
 * needs repair, or a blocked/cancelled task. An unstarted queued run counts as
 * a rest only with a pending card or parked agent setup naming why it waits.
 */
export function parkState(snapshot: ConfigSnapshot, now: number, settleMs: number): ParkState {
  if (snapshot.issueStatus === "done") return { kind: "done" };
  if (snapshot.runs.some(run => run.status === "running")) return { kind: "active", reason: "run_running" };
  const newest = Math.max(0, ...snapshot.runs.map(run => run.createdAt ?? 0));
  if (newest && now - newest < settleMs) return { kind: "active", reason: "run_recently_created" };
  const pendingCard = snapshot.cards.some(card => card.status === "pending");
  const setupParked = snapshot.agent?.retryRequired === true;
  const queued = snapshot.runs.some(run => run.status === "queued" && run.startedAt === null);
  if (queued) return pendingCard || setupParked ? { kind: "parked", reason: pendingCard ? "queued_with_card" : "queued_setup_parked" }
    : { kind: "active", reason: "queued_unstarted" };
  if (pendingCard) return { kind: "parked", reason: "card_pending" };
  if (snapshot.interruption && (snapshot.interruption.canRetry || snapshot.interruption.userAction)) return { kind: "parked", reason: "interruption" };
  if (setupParked) return { kind: "parked", reason: "agent_setup_parked" };
  if (snapshot.issueStatus === "blocked" || snapshot.issueStatus === "cancelled") return { kind: "parked", reason: `issue_${snapshot.issueStatus}` };
  return { kind: "active", reason: "no_named_wait" };
}

export interface ConfigTaskRecord {
  plan: ConfigTaskPlan;
  issueId: string | null;
  agentId: string | null;
  projectId: string | null;
  launchedAt: number | null;
  /** The break was refused on write (validation): the product prevents the stale reference. */
  refusedOnWrite: string | null;
  /** The harness itself could not set the task up (not a product verdict). */
  harnessError: string | null;
  brokenSnapshots: ConfigSnapshot[];
  parkedAt: number | null;
  parkReason: string | null;
  restart: { kind: ConfigRestartKind; faultId: string | null; firedAt: number; readyAt: number | null; error: string | null } | null;
  /** Every poll after the restart, while the setting is still broken. */
  afterRestartSnapshots: ConfigSnapshot[];
  /** The task rested again (or completed) after the restart. */
  afterRestartParked: boolean | null;
  /** Last snapshot after the repair (evidence when the task never completes). */
  afterRepair?: ConfigSnapshot | null;
  repair: { at: number; action: string; detail: string; error: string | null } | null;
  doneAt: number | null;
  finalStatus: string | null;
  /** A1 brief oracle result after repair. */
  brief: { ok: boolean; detail: string } | null;
}

/** Status codes that mean the server validated the request and refused the stale value. */
export function isWriteRefusal(status: number | null): boolean {
  return status === 400 || status === 422;
}

/**
 * Restarts and harness writes must not overlap: a write sent while the server
 * is down fails, and the task would be graded on a harness error. Writes share
 * the gate; a restart waits for writes in flight and holds new ones.
 */
export class RestartGate {
  private writers = 0;
  private restarting: Promise<void> | null = null;
  private idle: Array<() => void> = [];

  async write<T>(work: () => Promise<T>): Promise<T> {
    while (this.restarting) await this.restarting;
    this.writers += 1;
    try { return await work(); } finally {
      this.writers -= 1;
      if (!this.writers) for (const wake of this.idle.splice(0)) wake();
    }
  }

  async restart<T>(work: () => Promise<T>): Promise<T> {
    while (this.restarting) await this.restarting;
    let release!: () => void;
    this.restarting = new Promise<void>(resolve => { release = resolve; });
    try {
      while (this.writers) await new Promise<void>(resolve => this.idle.push(resolve));
      return await work();
    } finally {
      this.restarting = null;
      release();
    }
  }
}

export interface ConfigCheck { name: string; verdict: "pass" | "fail" | "n/a"; detail: string }
export interface ConfigGrade { pass: boolean; outcome: "completed" | "parked" | "refused_on_write" | "never_rested" | "harness_error"; checks: ConfigCheck[]; signature: string | null }

/** Runs created after this many attempts of unchanged configuration are a retry loop. */
export const MAX_BROKEN_RUNS = 3;
/** An unstarted queued run older than this with no named wait has no live owner. */
export const OWNERLESS_QUEUE_MS = 3 * 60_000;

export function gradeConfigTask(record: ConfigTaskRecord, options: { parkBoundMs: number }): ConfigGrade {
  const checks: ConfigCheck[] = [];
  const add = (name: string, verdict: ConfigCheck["verdict"], detail: string) => checks.push({ name, verdict, detail });
  if (record.harnessError) {
    return { pass: false, outcome: "harness_error", checks: [{ name: "harness", verdict: "fail", detail: record.harnessError }], signature: "harness_error" };
  }
  if (record.refusedOnWrite) {
    return { pass: true, outcome: "refused_on_write", checks: [{ name: "refused_on_write", verdict: "pass", detail: record.refusedOnWrite }], signature: null };
  }
  const reference = CONFIG_REFERENCES[record.plan.reference];
  const pattern = reference.names(record.plan.nonce);
  const last = record.brokenSnapshots.filter(snapshot => snapshot.reachable).at(-1) ?? null;
  const afterRestart = record.afterRestartSnapshots.filter(snapshot => snapshot.reachable);
  // Every sample while the setting was broken, before and after the restart.
  const whileBroken = [...record.brokenSnapshots, ...afterRestart];
  const lastBroken = afterRestart.at(-1) ?? last;
  const completedWhileBroken = last?.issueStatus === "done";
  const outcome: ConfigGrade["outcome"] = completedWhileBroken ? "completed" : record.parkedAt !== null ? "parked" : "never_rested";

  // 1. Bounded rest.
  if (completedWhileBroken) add("bounded_rest", "pass", "completed despite the broken setting");
  else if (record.parkedAt !== null && record.launchedAt !== null) {
    add("bounded_rest", record.parkedAt - record.launchedAt <= options.parkBoundMs ? "pass" : "fail",
      `parked (${record.parkReason}) after ${Math.round((record.parkedAt - record.launchedAt) / 1000)} s`);
  } else add("bounded_rest", "fail", `no rest within ${Math.round(options.parkBoundMs / 1000)} s (last: ${last ? parkState(last, last.at, 0).kind : "unreachable"})`);

  // 2. Actionable message naming the setting, on the task.
  if (completedWhileBroken) add("actionable_message", "n/a", "completed");
  else {
    const restingSnapshots = record.parkedAt !== null ? record.brokenSnapshots.filter(snapshot => snapshot.at >= record.parkedAt!) : record.brokenSnapshots;
    const named = [...new Set(restingSnapshots.flatMap(snapshot => namingTexts(taskLevelTexts(snapshot), pattern)))];
    const seen = [...new Set(restingSnapshots.flatMap(taskLevelTexts))];
    const runOnly = [...new Set(restingSnapshots.flatMap(snapshot => namingTexts(runDetailTexts(snapshot), pattern)))];
    if (named.length) add("actionable_message", "pass", truncate(named[0]!));
    else add("actionable_message", "fail", `${runOnly.length ? "message_only_in_run_detail: " + truncate(runOnly[0]!) + "; " : ""}user saw: ${seen.map(text => truncate(text)).join(" | ") || "nothing"}`);
  }

  // 3. No retry loop over unchanged configuration.
  const brokenRuns = new Set(whileBroken.flatMap(snapshot => snapshot.runs.map(run => run.id)));
  const lifecycleRetrying = whileBroken.some(snapshot => snapshot.agent?.lifecycleError && /retry automatically/i.test(snapshot.agent.lifecycleError)
    && snapshot.agent.retryRequired !== true);
  if (brokenRuns.size > MAX_BROKEN_RUNS) add("no_retry_loop", "fail", `retry_loop: ${brokenRuns.size} runs while the setting stayed broken`);
  else if (lifecycleRetrying && !completedWhileBroken) add("no_retry_loop", "fail", "lifecycle_retrying_unchanged_config: agent setup says it will retry automatically");
  else add("no_retry_loop", "pass", `${brokenRuns.size} run(s) while broken`);

  // 4. Nothing queued without a live owner.
  const ownerless = lastBroken ? ownerlessQueuedRun(lastBroken, OWNERLESS_QUEUE_MS) : null;
  add("no_ownerless_queue", ownerless ? "fail" : "pass", ownerless ? `queued_without_live_owner: run ${ownerless} unstarted with no named wait` : "none");

  // 5. Parked state survives the restart.
  if (!record.restart) add("survives_restart", "n/a", "no restart fired");
  else if (record.restart.error) add("survives_restart", "fail", `restart failed: ${record.restart.error}`);
  else if (completedWhileBroken) add("survives_restart", "n/a", "completed before the restart");
  else if (record.parkedAt === null) add("survives_restart", "n/a", "never parked");
  else if (!record.afterRestartParked) {
    const final = afterRestart.at(-1);
    add("survives_restart", "fail", `rest_lost_after_restart: ${record.restart.kind} while parked; then ${final ? stateLabel(parkState(final, final.at, 0)) : "unreachable"}`);
  } else {
    // The rest must still name the setting: a restart that leaves only a generic Retry fails.
    const final = afterRestart.at(-1);
    const named = final ? namingTexts(taskLevelTexts(final), pattern) : [];
    const namedBefore = checks.find(check => check.name === "actionable_message")?.verdict === "pass";
    if (final?.issueStatus === "done" || named.length || !namedBefore) {
      add("survives_restart", "pass", `${record.restart.kind} while parked; parked again${named.length ? `: ${truncate(named[0]!)}` : ""}`);
    } else {
      add("survives_restart", "fail", `message_lost_after_restart: ${record.restart.kind}; user then saw: ${final ? taskLevelTexts(final).map(text => truncate(text)).join(" | ") || "nothing" : "nothing"}`);
    }
  }

  // 6. Repair plus the offered action completes the task.
  if (completedWhileBroken) add("repair_completes", "n/a", "completed while broken");
  else if (!record.repair) add("repair_completes", "fail", "repair not attempted");
  else if (record.repair.error) add("repair_completes", "fail", `repair failed: ${record.repair.error}`);
  else add("repair_completes", record.finalStatus === "done" ? "pass" : "fail",
    `${record.repair.action}; final status ${record.finalStatus ?? "unknown"}${record.doneAt ? ` after ${Math.round((record.doneAt - record.repair.at) / 1000)} s` : ""}`);

  // 7. The work itself (A1 brief).
  if (record.brief) add("brief_oracle", record.brief.ok ? "pass" : "fail", record.brief.detail);
  else add("brief_oracle", "fail", "not collected");

  const failed = checks.filter(check => check.verdict === "fail");
  return { pass: failed.length === 0, outcome, checks,
    signature: failed.length ? `${record.plan.fault}/${record.plan.reference}:${failed.map(failureCode).join("+")}` : null };
}

/** A check's detail starting with a snake_case code names the failure; otherwise the check name does. */
function failureCode(check: ConfigCheck): string {
  const match = /^([a-z][a-z0-9_]+):/.exec(check.detail);
  return match ? match[1]! : check.name;
}

export function ownerlessQueuedRun(snapshot: ConfigSnapshot, olderThanMs: number): string | null {
  if (snapshot.cards.some(card => card.status === "pending") || snapshot.agent?.retryRequired) return null;
  const stale = snapshot.runs.find(run => run.status === "queued" && run.startedAt === null && run.createdAt !== null && snapshot.at - run.createdAt > olderThanMs);
  return stale?.id ?? null;
}

function stateLabel(state: ParkState): string {
  return state.kind === "done" ? "done" : `${state.kind} (${state.reason})`;
}

function truncate(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
