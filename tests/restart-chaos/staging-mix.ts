import type { ChaosApi } from "./api.js";
import { k15HoldMs } from "./redeploy.js";
import { createRng, K4_HOLD_RANGE_MS } from "./scheduler.js";
import type { AdapterId, FaultKind, OracleArtifacts, OracleResult, TaskFaultKind, TaskPlan, TaskRecord, TaskSample, WavePlan, WaveOptions } from "./types.js";
import type { WorkloadAgents, WorkloadDefinition } from "./workloads.js";

export const STAGING_MIX = "staging-mix";
export const ROUND_TICKS = 45;
export const ROUND_SECONDS = ROUND_TICKS * 2;
export const SUBTASKS_PER_PARENT = 2;
export const SUBTASK_ROUNDS = 2;
export const BURST_GAP_MS = 5_000;
export const FAULT_LEAD_MS = 60_000;
export const WARM_IDLE_MINUTES = 5;
export const DEFAULT_RATIO: ReadonlyArray<[AdapterId, number]> = [["opencode", 60], ["codex", 25], ["claude", 15]];
export const MIX_FAULT_KINDS: readonly FaultKind[] = ["K1", "K2", "K4", "K15"];
const ACTIVE = new Set(["queued", "running", "scheduled_retry"]);

export interface StagingMixOptions {
  runs: number;
  queue: number;
  minutes: number;
  turnMinutes: [number, number];
  ratio: Array<[AdapterId, number]>;
  subtaskShare: number;
  followUpShare: number;
  faultSpacingMinutes: number;
  holdMinutes: number;
  runCap: number;
  tasks?: number;
}

export interface StagingMixTask {
  turnMinutes: number;
  rounds: number;
  subtasks: number;
  followUpAfterMs: number | null;
  arriveAtMs: number;
  holdMs: number;
}

export interface StagingMixRecord {
  followUpErrors?: string[];
  followUp?: { at: number; commentId: string | null; duringRun: boolean; inOverlap: boolean; error: string | null };
  retrySeenAt?: number | null;
  retries?: Array<{ at: number; inOverlap: boolean }>;
}

export interface StagingMixArtifacts {
  followUp: StagingMixRecord["followUp"] | null;
  followUpErrors: string[];
  retries: NonNullable<StagingMixRecord["retries"]>;
}

export const STAGING_MIX_ARG_OPTIONS = {
  workload: { type: "string" },
  "mix-runs": { type: "string" },
  "mix-queue": { type: "string" },
  "mix-minutes": { type: "string" },
  "mix-turn-minutes": { type: "string" },
  "mix-ratio": { type: "string" },
  "mix-subtask-share": { type: "string" },
  "mix-follow-up-share": { type: "string" },
  "mix-fault-spacing-minutes": { type: "string" },
  "mix-hold-minutes": { type: "string" },
  "mix-run-cap": { type: "string" },
  "mix-tasks": { type: "string" },
} as const;

type MixArgs = Partial<Record<keyof typeof STAGING_MIX_ARG_OPTIONS, string | boolean | undefined>> & Record<string, unknown>;

function whole(raw: unknown, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) throw new Error(`--${name} must be a whole number`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`--${name} must be between ${min} and ${max}`);
  return value;
}

export function parseRange(raw: string, name: string, min: number, max: number): [number, number] {
  const match = /^([0-9]+)(?:-([0-9]+))?$/.exec(raw);
  const low = match ? Number(match[1]) : NaN, high = match ? Number(match[2] ?? match[1]) : NaN;
  if (!match || low < min || high > max || high < low) throw new Error(`--${name} takes <n> or <min>-<max>, ${min} to ${max}`);
  return [low, high];
}

export function parseRatio(raw: string): Array<[AdapterId, number]> {
  const entries = raw.split(",").map(part => part.trim()).filter(Boolean).map(part => {
    const match = /^(codex|claude|opencode)=([0-9]+)$/.exec(part);
    if (!match) throw new Error(`--mix-ratio takes adapter=weight pairs (opencode, codex, claude), got "${part}"`);
    return [match[1] as AdapterId, Number(match[2])] as [AdapterId, number];
  });
  if (new Set(entries.map(([adapter]) => adapter)).size !== entries.length) throw new Error("--mix-ratio names an adapter twice");
  const kept = entries.filter(([, weight]) => weight > 0);
  if (!kept.length) throw new Error("--mix-ratio needs at least one adapter with a positive weight");
  return kept;
}

export function warmSandboxHolders(mix: Pick<StagingMixOptions, "runs" | "queue" | "turnMinutes">, warm: boolean): number {
  const meanTurn = (mix.turnMinutes[0] + mix.turnMinutes[1]) / 2;
  return mix.runs + mix.queue + (warm ? Math.ceil(mix.runs * WARM_IDLE_MINUTES / Math.max(1, meanTurn)) : 0);
}

export function applyStagingMix(options: WaveOptions, values: MixArgs, environment: NodeJS.ProcessEnv = process.env): WaveOptions {
  const mixFlags = Object.keys(STAGING_MIX_ARG_OPTIONS).filter(key => key !== "workload" && values[key] !== undefined);
  if (values.workload === undefined) {
    if (mixFlags.length) throw new Error(`--${mixFlags[0]} needs --workload ${STAGING_MIX}`);
    return options;
  }
  if (values.workload !== STAGING_MIX) throw new Error(`Unknown --workload "${String(values.workload)}"; allowed: ${STAGING_MIX}`);
  for (const key of ["workloads", "adapters", "tasks", "concurrency", "matrix", "storm-minutes", "crash-point", "long-turn-minutes", "triggers"]) {
    if (values[key] !== undefined) throw new Error(`--workload ${STAGING_MIX} plans its own tasks; do not combine it with --${key}`);
  }
  const unsupported = options.faults.filter(fault => !MIX_FAULT_KINDS.includes(fault));
  if (unsupported.length) throw new Error(`--workload ${STAGING_MIX} plans ${MIX_FAULT_KINDS.join(", ")} or K0 on its own clock; remove ${unsupported.join(", ")}`);
  if (options.providerFaults?.length || options.diskFullFaults?.length || options.sessionFaults?.length) {
    throw new Error(`--workload ${STAGING_MIX} takes restart faults only`);
  }
  const runCapDefault = whole(environment.RESTART_CHAOS_MIX_RUN_CAP, "RESTART_CHAOS_MIX_RUN_CAP", 30, 1, 200);
  const mix: StagingMixOptions = {
    runs: whole(values["mix-runs"], "mix-runs", 30, 1, 200),
    queue: whole(values["mix-queue"], "mix-queue", 6, 0, 200),
    minutes: whole(values["mix-minutes"], "mix-minutes", 240, 1, 600),
    turnMinutes: parseRange(String(values["mix-turn-minutes"] ?? "15-45"), "mix-turn-minutes", 1, 60),
    ratio: values["mix-ratio"] === undefined ? DEFAULT_RATIO.map(([adapter, weight]) => [adapter, weight]) : parseRatio(String(values["mix-ratio"])),
    subtaskShare: whole(values["mix-subtask-share"], "mix-subtask-share", 30, 0, 100),
    followUpShare: whole(values["mix-follow-up-share"], "mix-follow-up-share", 50, 0, 100),
    faultSpacingMinutes: whole(values["mix-fault-spacing-minutes"], "mix-fault-spacing-minutes", 40, 1, 600),
    holdMinutes: whole(values["mix-hold-minutes"], "mix-hold-minutes", 10, 0, 60),
    runCap: whole(values["mix-run-cap"], "mix-run-cap", runCapDefault, 1, 200),
    ...(values["mix-tasks"] !== undefined ? { tasks: whole(values["mix-tasks"], "mix-tasks", 1, 1, 2_000) } : {}),
  };
  if (mix.runs > mix.runCap) {
    throw new Error(`--mix-runs ${mix.runs} exceeds the local run cap of ${mix.runCap} (--mix-run-cap or RESTART_CHAOS_MIX_RUN_CAP; see README "Staging mix")`);
  }
  if (mix.runs < mix.ratio.length) throw new Error(`--mix-runs must give each of the ${mix.ratio.length} adapters at least one run`);
  if (options.daytonaCpu !== undefined) {
    const budget = whole(environment.RESTART_CHAOS_DAYTONA_VCPU_BUDGET, "RESTART_CHAOS_DAYTONA_VCPU_BUDGET", 40, 1, 1_000);
    const holders = warmSandboxHolders(mix, options.daytonaWarm === true);
    if (holders * options.daytonaCpu > budget) {
      throw new Error(`--workload ${STAGING_MIX} may hold about ${holders} sandboxes × --daytona-cpu ${options.daytonaCpu} vCPU, `
        + `over the Daytona vCPU budget of ${budget}. Lower --mix-runs, --mix-queue or --daytona-cpu (RESTART_CHAOS_DAYTONA_VCPU_BUDGET sets the budget).`);
    }
  }
  return { ...options, workloads: ["SM"], adapters: mix.ratio.map(([adapter]) => adapter), concurrency: mix.runs + mix.queue,
    tasks: plannedTaskCount(mix), stagingMix: mix };
}

export function assignAdapters(ratio: ReadonlyArray<readonly [AdapterId, number]>, count: number): AdapterId[] {
  const total = ratio.reduce((sum, [, weight]) => sum + weight, 0);
  const current = ratio.map(() => 0);
  const out: AdapterId[] = [];
  for (let index = 0; index < count; index += 1) {
    let best = 0;
    ratio.forEach(([, weight], at) => {
      current[at]! += weight;
      if (current[at]! > current[best]!) best = at;
    });
    current[best]! -= total;
    out.push(ratio[best]![0]);
  }
  return out;
}

export function agentRunCaps(ratio: ReadonlyArray<readonly [AdapterId, number]>, runs: number): Partial<Record<AdapterId, number>> {
  if (runs < ratio.length) throw new Error(`${runs} runs cannot give each of the ${ratio.length} adapters one run`);
  const total = ratio.reduce((sum, [, weight]) => sum + weight, 0);
  const spare = runs - ratio.length;
  const caps = ratio.map(([adapter, weight]) => ({ adapter, exact: (spare * weight) / total, cap: 1 }));
  for (const entry of caps) entry.cap += Math.floor(entry.exact);
  let left = runs - caps.reduce((sum, entry) => sum + entry.cap, 0);
  const byRemainder = [...caps].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
  for (let index = 0; left > 0; index = (index + 1) % byRemainder.length, left -= 1) byRemainder[index]!.cap += 1;
  return Object.fromEntries(caps.map(entry => [entry.adapter, entry.cap]));
}

function meanCycleMs(mix: Pick<StagingMixOptions, "turnMinutes">): number {
  return ((mix.turnMinutes[0] + mix.turnMinutes[1]) / 2 + 5) * 60_000;
}

export function plannedTaskCount(mix: Pick<StagingMixOptions, "runs" | "queue" | "minutes" | "turnMinutes" | "tasks">): number {
  if (mix.tasks !== undefined) return mix.tasks;
  const burst = mix.runs + mix.queue;
  const steadyMs = Math.max(0, mix.minutes * 60_000 - burst * BURST_GAP_MS);
  return burst + Math.floor((steadyMs / meanCycleMs(mix)) * mix.runs);
}

export function planArrivals(count: number, burst: number, durationMs: number, next: () => number): number[] {
  const arrivals: number[] = [];
  const head = Math.min(count, burst);
  for (let index = 0; index < head; index += 1) arrivals.push(index * BURST_GAP_MS);
  const rest = count - head;
  if (!rest) return arrivals;
  const start = head * BURST_GAP_MS;
  const step = Math.max(1_000, (durationMs - start) / rest);
  for (let index = 0; index < rest; index += 1) {
    const jitter = (next() - 0.5) * step * 0.5;
    arrivals.push(Math.round(Math.min(durationMs - 1_000, Math.max(start, start + index * step + step / 2 + jitter))));
  }
  return arrivals.sort((a, b) => a - b);
}

export interface LiveWindow { arriveAtMs: number; turnMs: number }

export function planFaultCarriers(windows: readonly LiveWindow[], spacingMs: number, durationMs: number, kinds: readonly FaultKind[]) {
  const carriers = new Map<number, { kind: FaultKind; fireAfterMs: number }>();
  const missedSlotsMs: number[] = [];
  if (!kinds.length) return { carriers, missedSlotsMs };
  for (let slot = 1; slot * spacingMs < durationMs; slot += 1) {
    const at = slot * spacingMs;
    let pick = -1;
    windows.forEach((window, index) => {
      const live = window.arriveAtMs + FAULT_LEAD_MS <= at && at <= window.arriveAtMs + window.turnMs;
      if (live && !carriers.has(index) && (pick < 0 || window.arriveAtMs > windows[pick]!.arriveAtMs)) pick = index;
    });
    if (pick < 0) { missedSlotsMs.push(at); continue; }
    carriers.set(pick, { kind: kinds[(slot - 1) % kinds.length]!, fireAfterMs: at - windows[pick]!.arriveAtMs });
  }
  return { carriers, missedSlotsMs };
}

export const roundsFor = (minutes: number) => Math.max(1, Math.ceil((minutes * 60) / ROUND_SECONDS));

export function planStagingMixTasks(options: WaveOptions): TaskPlan[] {
  const mix = options.stagingMix!;
  const rng = createRng((options.seed ^ 0x5d1a6e1f) >>> 0);
  const count = options.tasks;
  const durationMs = mix.minutes * 60_000;
  const arrivals = planArrivals(count, mix.runs + mix.queue, durationMs, rng.next);
  const adapters = assignAdapters(mix.ratio, count);
  const drawn = arrivals.map(arriveAtMs => {
    const turnMinutes = rng.int(mix.turnMinutes[0], mix.turnMinutes[1]);
    const rounds = roundsFor(turnMinutes);
    const turnMs = rounds * ROUND_SECONDS * 1_000;
    const subtasks = rng.int(0, 99) < mix.subtaskShare ? SUBTASKS_PER_PARENT : 0;
    const followUpAfterMs = rng.int(0, 99) < mix.followUpShare ? rng.int(Math.round(turnMs * 0.25), Math.round(turnMs * 0.7)) : null;
    return { arriveAtMs, turnMinutes, rounds, turnMs, subtasks, followUpAfterMs };
  });
  const { carriers, missedSlotsMs } = planFaultCarriers(drawn, mix.faultSpacingMinutes * 60_000, durationMs, options.faults);
  if (missedSlotsMs.length) {
    throw new Error(`No planned task is still in its turn at the fault slot(s) ${missedSlotsMs.map(at => `${Math.round(at / 60_000)} min`).join(", ")}; `
      + "lengthen --mix-turn-minutes, add tasks, shorten --mix-minutes or change --mix-fault-spacing-minutes");
  }
  return drawn.map(({ arriveAtMs, turnMinutes, rounds, subtasks, followUpAfterMs }, index) => {
    const carrier = carriers.get(index);
    const fault: TaskFaultKind = carrier?.kind ?? "K0";
    return {
      taskId: `t${String(index + 1).padStart(3, "0")}`,
      index,
      workload: "SM",
      adapter: adapters[index]!,
      fault,
      fireAfterMs: carrier?.fireAfterMs ?? 0,
      holdMs: fault === "K15" ? k15HoldMs(options.k15HoldMs, rng.int) : fault === "K4" ? rng.int(...K4_HOLD_RANGE_MS) : 0,
      followUpAfterMs: null,
      nonce: rng.hex(8),
      stagingMix: { turnMinutes, rounds, subtasks, followUpAfterMs, arriveAtMs, holdMs: mix.holdMinutes * 60_000 },
    };
  });
}

export function planStagingMixWave(waveId: string, options: WaveOptions, createdAt = new Date()): WavePlan {
  return { schema: "paperclip.restart-chaos.wave-plan/v1", waveId, seed: options.seed, createdAt: createdAt.toISOString(), options,
    tasks: planStagingMixTasks(options) };
}

export function posixCksum(text: string): number {
  const bytes = Buffer.from(text, "utf8");
  let crc = 0;
  const update = (byte: number) => {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) : crc << 1) >>> 0;
  };
  for (const byte of bytes) update(byte);
  for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) update(length & 0xff);
  return (~crc) >>> 0;
}

export function expectedRoundHash(nonce: string, round: number, ticks = ROUND_TICKS): string {
  let hash = `${nonce}-${round}`;
  for (let tick = 1; tick <= ticks; tick += 1) hash = String(posixCksum(`${hash} ${tick}`));
  return hash;
}

export const ledgerFile = (nonce: string) => `ledger-${nonce}.log`;
export const childNonce = (nonce: string, part: number) => `${nonce}s${part}`;
export const followUpMarker = (nonce: string) => `FOLLOWUP-${nonce}`;
export const doneMarker = (nonce: string) => `DONE-${nonce}`;
export const childLine = (part: number, hash: string) => `CHILD-${part}=${hash}`;

export function roundCommand(nonce: string): string {
  return `s=$(date +%s); h=${nonce}-<N>; j=0; while [ $j -lt ${ROUND_TICKS} ]; do j=$((j+1)); h=$(printf '%s %s' "$h" "$j" | cksum | cut -d' ' -f1); sleep 2; done;`
    + ` echo "ROUND <N> $s $(date +%s) $h" >> ${ledgerFile(nonce)}; tail -n 1 ${ledgerFile(nonce)}`;
}

function roundsSteps(nonce: string, rounds: number): string[] {
  return [
    `Run this shell command ${rounds} times, as separate tool calls in the foreground, replacing every <N> with the round number 1 to ${rounds}`,
    `(each takes about ${ROUND_SECONDS} seconds; do not run rounds in the background or in parallel, and do not skip, repeat or shorten any):`,
    `\`${roundCommand(nonce)}\``,
  ];
}

export function subtaskDescription(nonce: string): string {
  return [
    "Work in your working directory, in this turn.",
    ...roundsSteps(nonce, SUBTASK_ROUNDS),
    `Then save the full contents of \`${ledgerFile(nonce)}\` as this issue's document with key \`ledger\` (title "Ledger"), exactly as the file reads.`,
    "Do not create other tasks. Then mark this task done.",
  ].join("\n");
}

export function stagingMixDescription(nonce: string, task: StagingMixTask, agents?: WorkloadAgents): string {
  const self = agents ? `${agents.self.name} (agent id ${agents.self.id})` : "yourself";
  const parent = task.subtasks > 0;
  const lines = ["This is a long-running task. Do every step in your working directory, in this turn unless a step says otherwise.", ""];
  let step = 1;
  if (parent) {
    lines.push(`${step++}. First create exactly ${task.subtasks} subtasks, each with this task as its parent, assigned to ${self}, status \`todo\`. Create each one once.`);
    for (let part = 1; part <= task.subtasks; part += 1) {
      lines.push(`   Subtask ${part}: title "SM sub ${part} ${childNonce(nonce, part)}", description exactly:`, "   ```",
        ...subtaskDescription(childNonce(nonce, part)).split("\n").map(line => `   ${line}`), "   ```");
    }
    lines.push("   Do not do the subtasks' work yourself.");
  }
  lines.push(`${step++}. ${roundsSteps(nonce, task.rounds).join("\n   ")}`);
  lines.push(`${step++}. If the board comments while you work and asks you to include a line, keep working and include that line on its own line in the document below.`);
  if (parent) {
    lines.push(`${step++}. Wait until both subtasks are done. If they are not done yet, end your turn without marking this task done; you will be woken when they finish.`,
      `   Then read each subtask's \`ledger\` document and take the hash at the end of its last ROUND line.`);
  }
  lines.push(`${step++}. Save this issue's document with key \`ledger\` (title "Ledger"): the full contents of \`${ledgerFile(nonce)}\` exactly as the file reads,`
    + ` then every line the board asked for${parent ? `, then one line \`${childLine(1, "<hash>")}\` per subtask (CHILD-2 for subtask 2), with <hash> from that subtask's ledger` : ""}.`);
  lines.push(`${step++}. Post exactly one comment on this task with the body \`${doneMarker(nonce)}\`. Then mark this task done.`);
  return lines.join("\n");
}

export function followUpComment(nonce: string): string {
  return `Additional requirement: include the line \`${followUpMarker(nonce)}\` on its own line in this task's \`ledger\` document. Keep going with your rounds; do not restart any.`;
}

export interface LedgerRound { round: number; start: number; end: number; hash: string }

export function parseLedger(text: string | null | undefined): LedgerRound[] {
  return (text ?? "").split(/\r?\n/).flatMap(line => {
    const match = /^\s*ROUND ([0-9]+) ([0-9]{9,11}) ([0-9]{9,11}) ([0-9]+)\s*$/.exec(line);
    return match ? [{ round: Number(match[1]), start: Number(match[2]), end: Number(match[3]), hash: match[4]! }] : [];
  });
}

export function verifyLedger(nonce: string, rounds: number, text: string | null | undefined) {
  const lines = parseLedger(text);
  const missing: number[] = [], wrong: number[] = [], short: number[] = [];
  let duplicates = 0;
  for (let round = 1; round <= rounds; round += 1) {
    const matching = lines.filter(line => line.round === round);
    if (!matching.length) { missing.push(round); continue; }
    duplicates += matching.length - 1;
    if (!matching.some(line => line.hash === expectedRoundHash(nonce, round))) wrong.push(round);
    if (!matching.some(line => line.end - line.start >= ROUND_SECONDS - 10)) short.push(round);
  }
  duplicates += lines.filter(line => line.round < 1 || line.round > rounds).length;
  const verified = !missing.length && !wrong.length && !short.length;
  return { verified, duplicates, detail: `rounds=${rounds - missing.length}/${rounds}${missing.length ? ` missing=${missing.join(",")}` : ""}`
    + `${wrong.length ? ` wrong_hash=${wrong.join(",")}` : ""}${short.length ? ` short=${short.join(",")}` : ""}${duplicates ? ` duplicates=${duplicates}` : ""}` };
}

export function gradeStagingMix(nonce: string, task: StagingMixTask, artifacts: OracleArtifacts): OracleResult {
  const ledger = artifacts.documents.ledger ?? null;
  const own = verifyLedger(nonce, task.rounds, ledger);
  const doneComments = artifacts.agentComments.filter(body => body.includes(doneMarker(nonce))).length;
  const followUp = artifacts.stagingMix?.followUp ?? null;
  const children = (artifacts.children ?? []).filter(child => (child.title ?? "").includes(nonce));
  const checks: OracleResult["checks"] = [
    { name: "issue_done", ok: artifacts.issueStatus === "done", detail: `status=${artifacts.issueStatus ?? "unknown"}` },
    { name: "ledger_rounds_verified", ok: own.verified, detail: own.detail },
    { name: "rounds_once", ok: own.duplicates === 0, detail: `duplicates=${own.duplicates}` },
    { name: "done_comment_once", ok: doneComments === 1, detail: `comments=${doneComments}` },
  ];
  if (task.followUpAfterMs !== null) {
    const errors = artifacts.stagingMix?.followUpErrors ?? [];
    checks.push({ name: "follow_up_posted", ok: Boolean(followUp?.commentId),
      detail: followUp?.commentId ? `comment ${followUp.commentId}` : `never posted${errors.length ? `; errors: ${errors.slice(-3).join(" | ")}` : ""}` });
  }
  if (followUp?.commentId && followUp.duringRun) {
    checks.push({ name: "follow_up_served", ok: (ledger ?? "").includes(followUpMarker(nonce)),
      detail: `posted ${new Date(followUp.at).toISOString()}${followUp.inOverlap ? " in overlap" : ""}` });
  }
  if (task.subtasks > 0) {
    checks.push({ name: "subtasks_once", ok: children.length === task.subtasks, detail: `subtasks=${children.length}/${task.subtasks}` });
    for (let part = 1; part <= task.subtasks; part += 1) {
      const nonceOf = childNonce(nonce, part);
      const child = children.filter(candidate => (candidate.title ?? "").includes(nonceOf));
      const result = verifyLedger(nonceOf, SUBTASK_ROUNDS, child[0]?.documents.ledger);
      const lastHash = expectedRoundHash(nonceOf, SUBTASK_ROUNDS);
      checks.push({ name: `subtask_${part}_done`, ok: child.length === 1 && child[0]!.status === "done" && result.verified && result.duplicates === 0,
        detail: child.length ? `status=${child[0]!.status} ${result.detail}` : "missing" });
      checks.push({ name: `parent_read_subtask_${part}`, ok: (ledger ?? "").includes(childLine(part, lastHash)), detail: childLine(part, lastHash) });
    }
  }
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}

export function stagingMixBudgetMs(task: StagingMixTask): number {
  const turnMs = task.rounds * ROUND_SECONDS * 1_000;
  return Math.round(turnMs * 1.5) + 20 * 60_000 + (task.subtasks ? 20 * 60_000 : 0);
}

export function stagingMixDefinition(task: StagingMixTask): WorkloadDefinition {
  return {
    id: "SM",
    label: "Staging mix: long tool turn, subtasks, follow-ups",
    usesRepository: false,
    fireWindowMs: [0, 0],
    budgetMs: stagingMixBudgetMs(task),
    title: nonce => `Staging mix ${task.subtasks ? "parent" : "task"} ${nonce}`,
    description: (nonce, agents) => stagingMixDescription(nonce, task, agents),
    collect: { documents: ["ledger"], files: () => [], commands: [], ...(task.subtasks ? { childDocuments: ["ledger"] } : {}) },
    grade: (nonce, artifacts) => gradeStagingMix(nonce, task, artifacts),
  };
}

export const stagingMixWorkloadDefinition = stagingMixDefinition({ turnMinutes: 15, rounds: roundsFor(15), subtasks: 0, followUpAfterMs: null, arriveAtMs: 0, holdMs: 0 });

export type OverlapProbe = (now: number) => boolean;
let overlapProbe: OverlapProbe | null = null;

export function setOverlapProbe(probe: OverlapProbe | null): void {
  overlapProbe = probe;
}

export function insideOverlapWindow(now: number, fallback: { faultInProgress: boolean; reachable: boolean }): boolean {
  return overlapProbe ? overlapProbe(now) : fallback.faultInProgress && fallback.reachable;
}

function retryOffered(sample: TaskSample): boolean {
  return sample.reachable && sample.issueStatus !== "done" && Boolean(sample.interruption?.canRetry)
    && !(sample.runs ?? []).some(run => ACTIVE.has(run.status));
}

export function retryDue(record: Pick<TaskRecord, "retry" | "lastFaultAt">): boolean {
  return !record.retry || (record.lastFaultAt ?? 0) > record.retry.at;
}

export function holdsRetry(record: Pick<TaskRecord, "stagingMix">, holdMs: number, now: number): boolean {
  const seen = record.stagingMix?.retrySeenAt;
  return seen != null && now - seen < holdMs;
}

export interface StagingMixStepInput {
  api: Pick<ChaosApi, "post">;
  record: TaskRecord;
  task: StagingMixTask;
  nonce: string;
  sample: TaskSample;
  now: number;
  faultInProgress: boolean;
  retry: (sample: TaskSample, now: number) => Promise<void>;
  note: (kind: string, data: Record<string, unknown>) => void;
}

export async function stagingMixStep(input: StagingMixStepInput): Promise<void> {
  const { record, task, sample, now } = input;
  const state = record.stagingMix ??= {};
  if (!sample.reachable || !record.issueId || record.createdAt === null) return;
  const overlap = insideOverlapWindow(now, { faultInProgress: input.faultInProgress, reachable: sample.reachable });
  const running = (sample.runs ?? []).some(run => run.status === "running");
  if (task.followUpAfterMs !== null && !state.followUp && running) {
    const plannedAt = record.createdAt + task.followUpAfterMs;
    const latestAt = Math.min(plannedAt + task.holdMs, record.createdAt + Math.round(task.rounds * ROUND_SECONDS * 1_000 * 0.85));
    if (now >= plannedAt && (overlap || now >= latestAt)) {
      const followUp: NonNullable<StagingMixRecord["followUp"]> = { at: now, commentId: null, duringRun: true, inOverlap: overlap, error: null };
      try {
        const comment = await input.api.post<{ id?: string }>(`/api/issues/${record.issueId}/comments`, { body: followUpComment(input.nonce) });
        followUp.commentId = typeof comment?.id === "string" ? comment.id : null;
        if (!followUp.commentId) followUp.error = "the comment response had no id";
      } catch (error) {
        followUp.error = error instanceof Error ? error.message : String(error);
      }
      if (followUp.commentId) state.followUp = followUp;
      else (state.followUpErrors ??= []).push(followUp.error!);
      input.note("staging_mix_follow_up", { ...followUp });
    }
  }
  if (!retryOffered(sample) || !retryDue(record)) {
    if (!retryOffered(sample)) state.retrySeenAt = null;
    return;
  }
  state.retrySeenAt ??= now;
  if (!overlap) return;
  (state.retries ??= []).push({ at: now, inOverlap: true });
  input.note("staging_mix_retry_in_overlap", { waitedMs: now - state.retrySeenAt });
  await input.retry(sample, now);
}

export function stagingMixArtifacts(record: TaskRecord): StagingMixArtifacts {
  return { followUp: record.stagingMix?.followUp ?? null, followUpErrors: record.stagingMix?.followUpErrors ?? [], retries: record.stagingMix?.retries ?? [] };
}
