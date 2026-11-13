import type { ChaosApi } from "./api.js";
import { k15HoldMs } from "./redeploy.js";
import { createRng, k4HoldRange, stableRequestId } from "./plan-primitives.js";
import type { AdapterId, FaultKind, OracleArtifacts, OracleResult, TaskFaultKind, TaskPlan, TaskRecord, TaskSample, WavePlan, WaveOptions } from "./types.js";
import type { WorkloadAgents, WorkloadDefinition } from "./workloads.js";

export const STAGING_MIX = "staging-mix";
export const MIX_MAX_MINUTES = 600;
export const ROUND_TICKS = 45;
export const ROUND_SECONDS = ROUND_TICKS * 2;
export const SUBTASKS_PER_PARENT = 2;
export const SUBTASK_ROUNDS = 2;
export const BURST_GAP_MS = 5_000;
export const WARM_IDLE_MINUTES = 5;
export const DEFAULT_RATIO: ReadonlyArray<[AdapterId, number]> = [["opencode", 60], ["codex", 25], ["claude", 15]];
export const DEFAULT_MIN_FREE_MB = 3_072;
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
  minFreeMb: number;
  arrivalCutoffMinutes: number;
  arrivalEndMs: number;
  retryDuringWave: boolean;
  settleMinutes: number;
  tasks?: number;
}

export interface StagingMixSlot { atMs: number; kind: FaultKind; holdMs: number }

export interface StagingMixTask {
  turnMinutes: number;
  rounds: number;
  subtasks: number;
  followUpAfterMs: number | null;
  arriveAtMs: number;
  holdMs: number;
  retryDuringWave?: boolean;
}

export interface StagingMixRecord {
  followUpErrors?: string[];
  followUp?: { at: number; commentId: string | null; duringRun: boolean; inOverlap: boolean; error: string | null };
  afterEndFollowUps?: Array<{ afterRunEndAt: number; at: number; delayMs: number; commentId: string }>;
  retrySeenAt?: number | null;
  retries?: Array<{ at: number; inOverlap: boolean }>;
  retryBanner?: RetryBanner;
  retryAfterSettle?: { at: number; accepted: boolean | null; issueStatusAtClick: string | null };
  completion?: CompletionEvidence;
}

export interface CompletionEvidence {
  completedAt: number | null;
  runs: Array<{ runId: string | null; startedAt: number | null; acceptedDisposition: string | null; acceptedAt: number | null; answersFollowUp?: boolean }>;
}

export interface RetryBanner { firstShownAt: number; lastShownAt: number; shownMs: number; visibleSince: number | null; errorCode: string | null }

export interface StagingMixArtifacts {
  followUp: StagingMixRecord["followUp"] | null;
  followUpErrors: string[];
  retries: NonNullable<StagingMixRecord["retries"]>;
  comments?: Array<{ body: string; runId: string | null; createdAt?: number | null }>;
  commentsUnreadable?: boolean;
  completion?: CompletionEvidence;
  afterEndFollowUps?: NonNullable<StagingMixRecord["afterEndFollowUps"]>;
}

export const DUPLICATE_CHECKS: ReadonlySet<string> = new Set(["rounds_once", "done_comment_once", "completion_once", "subtasks_once", "subtask_rounds_once"]);

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
  "mix-arrival-cutoff-minutes": { type: "string" },
  "mix-retry-during-wave": { type: "boolean" },
  "mix-settle-minutes": { type: "string" },
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
  for (const key of ["workloads", "adapters", "tasks", "concurrency", "matrix", "storm-minutes", "crash-point", "long-turn-minutes", "triggers", "fault-after-seconds"]) {
    if (values[key] !== undefined) throw new Error(`--workload ${STAGING_MIX} plans its own tasks; do not combine it with --${key}`);
  }
  const unsupported = options.faults.filter(fault => !MIX_FAULT_KINDS.includes(fault));
  if (unsupported.length) throw new Error(`--workload ${STAGING_MIX} plans ${MIX_FAULT_KINDS.join(", ")} or K0 on its own clock; remove ${unsupported.join(", ")}`);
  if (options.providerFaults?.length || options.diskFullFaults?.length || options.sessionFaults?.length) {
    throw new Error(`--workload ${STAGING_MIX} takes restart faults only`);
  }
  const turnMinutes = parseRange(String(values["mix-turn-minutes"] ?? "15-45"), "mix-turn-minutes", 1, 60);
  const minutes = whole(values["mix-minutes"], "mix-minutes", 240, 1, MIX_MAX_MINUTES);
  const faultSpacingMinutes = whole(values["mix-fault-spacing-minutes"], "mix-fault-spacing-minutes", 40, 1, 600);
  const arrivalCutoffMinutes = whole(values["mix-arrival-cutoff-minutes"], "mix-arrival-cutoff-minutes", turnMinutes[1], 0, 600);
  const runCapDefault = whole(environment.RESTART_CHAOS_MIX_RUN_CAP, "RESTART_CHAOS_MIX_RUN_CAP", 30, 1, 200);
  const mix: StagingMixOptions = {
    runs: whole(values["mix-runs"], "mix-runs", 30, 1, 200),
    queue: whole(values["mix-queue"], "mix-queue", 6, 0, 200),
    minutes,
    turnMinutes,
    ratio: values["mix-ratio"] === undefined ? DEFAULT_RATIO.map(([adapter, weight]) => [adapter, weight]) : parseRatio(String(values["mix-ratio"])),
    subtaskShare: whole(values["mix-subtask-share"], "mix-subtask-share", 30, 0, 100),
    followUpShare: whole(values["mix-follow-up-share"], "mix-follow-up-share", 50, 0, 100),
    faultSpacingMinutes,
    holdMinutes: whole(values["mix-hold-minutes"], "mix-hold-minutes", 10, 0, 60),
    runCap: whole(values["mix-run-cap"], "mix-run-cap", runCapDefault, 1, 200),
    minFreeMb: whole(environment.RESTART_CHAOS_MIX_MIN_FREE_MB, "RESTART_CHAOS_MIX_MIN_FREE_MB", DEFAULT_MIN_FREE_MB, 0, 1_048_576),
    arrivalCutoffMinutes,
    arrivalEndMs: arrivalEndMs({ minutes, faultSpacingMinutes, arrivalCutoffMinutes }, options),
    retryDuringWave: values["mix-retry-during-wave"] === true,
    settleMinutes: whole(values["mix-settle-minutes"], "mix-settle-minutes", 15, 0, 120),
    ...(values["mix-tasks"] !== undefined ? { tasks: whole(values["mix-tasks"], "mix-tasks", 1, 1, 2_000) } : {}),
  };
  if (mix.tasks === undefined && mix.arrivalEndMs < (mix.runs + mix.queue) * BURST_GAP_MS) {
    throw new Error(`The staging-mix arrival window is empty: arrivals stop ${mix.arrivalCutoffMinutes} min (--mix-arrival-cutoff-minutes, default the longest turn) `
      + `before ${options.faults.length ? "the last fault slot ends" : "--mix-minutes ends"}, at ${(mix.arrivalEndMs / 60_000).toFixed(1)} min. `
      + "Raise --mix-minutes, shorten --mix-turn-minutes or lower --mix-arrival-cutoff-minutes");
  }
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

export function slotTimesMs(mix: Pick<StagingMixOptions, "minutes" | "faultSpacingMinutes">,
  firstSlotRaw = process.env.RESTART_CHAOS_MIX_FIRST_SLOT_SECONDS): number[] {
  const spacing = mix.faultSpacingMinutes * 60_000;
  const first = firstSlotRaw && /^[0-9]+$/.test(firstSlotRaw) ? Math.min(Number(firstSlotRaw) * 1000, spacing) : spacing;
  const count = Math.max(0, Math.ceil((mix.minutes * 60_000 - spacing) / spacing));
  return Array.from({ length: count }, (_, index) => first + index * spacing);
}

export function maxSlotHoldMs(options: Pick<WaveOptions, "faults" | "k15HoldMs" | "k4HoldMaxMs">): number {
  return Math.max(0, ...options.faults.map(kind => kind === "K15" ? options.k15HoldMs?.[1] ?? 0 : kind === "K4" ? k4HoldRange(options.k4HoldMaxMs)[1] : 0));
}

export function arrivalEndMs(mix: Pick<StagingMixOptions, "minutes" | "faultSpacingMinutes" | "arrivalCutoffMinutes">,
  options: Pick<WaveOptions, "faults" | "k15HoldMs" | "k4HoldMaxMs">): number {
  const slots = options.faults.length ? slotTimesMs(mix) : [];
  const horizon = slots.length ? slots.at(-1)! + maxSlotHoldMs(options) : mix.minutes * 60_000;
  return Math.max(0, horizon - mix.arrivalCutoffMinutes * 60_000);
}

export function plannedTaskCount(mix: Pick<StagingMixOptions, "runs" | "queue" | "arrivalEndMs" | "turnMinutes" | "tasks">): number {
  if (mix.tasks !== undefined) return mix.tasks;
  const burst = mix.runs + mix.queue;
  const steadyMs = Math.max(0, mix.arrivalEndMs - burst * BURST_GAP_MS);
  return burst + Math.floor((steadyMs / meanCycleMs(mix)) * mix.runs);
}

export function planArrivals(count: number, burst: number, durationMs: number, next: () => number): number[] {
  const arrivals: number[] = [];
  const head = Math.min(count, burst);
  for (let index = 0; index < head; index += 1) arrivals.push(index * BURST_GAP_MS);
  const rest = count - head;
  if (!rest) return arrivals;
  const start = head * BURST_GAP_MS;
  const end = Math.max(start + 1_000, durationMs);
  const step = Math.max(1_000, (end - start) / rest);
  for (let index = 0; index < rest; index += 1) {
    const jitter = (next() - 0.5) * step * 0.5;
    arrivals.push(Math.round(Math.min(end - 1_000, Math.max(start, start + index * step + step / 2 + jitter))));
  }
  return arrivals.sort((a, b) => a - b);
}

export function planFaultSlots(options: WaveOptions, int: (min: number, max: number) => number): StagingMixSlot[] {
  const mix = options.stagingMix!;
  if (!options.faults.length) return [];
  return slotTimesMs(mix).map((atMs, index) => {
    const kind = options.faults[index % options.faults.length]!;
    return { atMs, kind, holdMs: kind === "K15" ? k15HoldMs(options.k15HoldMs, int) : kind === "K4" ? int(...k4HoldRange(options.k4HoldMaxMs)) : 0 };
  });
}

export const roundsFor = (minutes: number) => Math.max(1, Math.ceil((minutes * 60) / ROUND_SECONDS));

export function planStagingMixTasks(options: WaveOptions, rng = createRng((options.seed ^ 0x5d1a6e1f) >>> 0)): TaskPlan[] {
  const mix = options.stagingMix!;
  const count = options.tasks;
  const arrivals = planArrivals(count, mix.runs + mix.queue, mix.arrivalEndMs, rng.next);
  const adapters = assignAdapters(mix.ratio, count);
  return arrivals.map((arriveAtMs, index) => {
    const turnMinutes = rng.int(mix.turnMinutes[0], mix.turnMinutes[1]);
    const rounds = roundsFor(turnMinutes);
    const turnMs = rounds * ROUND_SECONDS * 1_000;
    const subtasks = rng.int(0, 99) < mix.subtaskShare ? SUBTASKS_PER_PARENT : 0;
    const followUpAfterMs = rng.int(0, 99) < mix.followUpShare ? rng.int(Math.round(turnMs * 0.25), Math.round(turnMs * 0.7)) : null;
    const fault: TaskFaultKind = options.faults.length ? "K13" : "K0";
    return {
      taskId: `t${String(index + 1).padStart(3, "0")}`,
      index,
      workload: "SM",
      adapter: adapters[index]!,
      fault,
      fireAfterMs: 0,
      holdMs: 0,
      followUpAfterMs: null,
      nonce: rng.hex(8),
      stagingMix: { turnMinutes, rounds, subtasks, followUpAfterMs, arriveAtMs, holdMs: mix.holdMinutes * 60_000,
        ...(mix.retryDuringWave ? { retryDuringWave: true } : {}) },
    };
  });
}

export function planStagingMixWave(waveId: string, options: WaveOptions, createdAt = new Date()): WavePlan {
  const rng = createRng((options.seed ^ 0x5d1a6e1f) >>> 0);
  const tasks = planStagingMixTasks(options, rng);
  return { schema: "paperclip.restart-chaos.wave-plan/v1", waveId, seed: options.seed, createdAt: createdAt.toISOString(), options, tasks,
    stagingMixSlots: planFaultSlots(options, rng.int) };
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
    `(each takes about ${ROUND_SECONDS} seconds; run them one at a time in the foreground, never in the background or in parallel):`,
    `\`${roundCommand(nonce)}\``,
    `Every round from 1 to ${rounds} must end up in \`${ledgerFile(nonce)}\` exactly once, with the hash the command printed.`,
    "Before each round, read the ledger file: if that round's ROUND line is already there, the round is finished, so never run it again.",
    "If a round was interrupted (for example the tool call failed or your session restarted) before its ROUND line was written, you must run that round again from the start.",
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
    lines.push(`${step++}. Wait until both subtasks are done. If they are not done yet, end your turn now: do not save the \`ledger\` document, do not post the`
      + ` \`${doneMarker(nonce)}\` comment and do not mark this task done. You will be woken when they finish.`,
      `   Then read each subtask's \`ledger\` document and take the hash at the end of its last ROUND line.`);
  }
  lines.push(`${step++}. Save this issue's document with key \`ledger\` (title "Ledger"): the full contents of \`${ledgerFile(nonce)}\` exactly as the file reads,`
    + ` then every line the board asked for${parent ? `, then one line \`${childLine(1, "<hash>")}\` per subtask (CHILD-2 for subtask 2), with <hash> from that subtask's ledger` : ""}.`);
  lines.push(`${step++}. ${parent ? "Only after both subtasks are done and both CHILD lines are in the `ledger` document, post" : "Post"} exactly one comment on this task`
    + ` with the body \`${doneMarker(nonce)}\`. Then mark this task done.`);
  return lines.join("\n");
}

export const followUpRequestId = (issueId: string, nonce: string) => stableRequestId(`followup-${issueId}-${nonce}`);

type CommentEvidence = { body: string; runId: string | null; createdAt?: number | null };

export function firstDoneCommentAt(comments: readonly CommentEvidence[], nonce: string): number | null {
  const times = comments.filter(comment => isDoneComment(comment.body, nonce) && typeof comment.createdAt === "number").map(comment => comment.createdAt!);
  return times.length ? Math.min(...times) : null;
}

export function hasDispositions(completion: CompletionEvidence | null | undefined): completion is CompletionEvidence {
  return Boolean(completion?.runs.some(run => run.acceptedDisposition !== null));
}

export function completedAtAnchor(completion: CompletionEvidence | null | undefined, comments: readonly CommentEvidence[], nonce: string):
  { at: number | null; source: "accepted_result" | "completed_at" | "done_comment" | null } {
  const accepted = (completion?.runs ?? []).filter(run => run.acceptedDisposition === "done" && run.acceptedAt !== null).map(run => run.acceptedAt!);
  if (accepted.length) return { at: Math.min(...accepted), source: "accepted_result" };
  if (completion?.completedAt != null) return { at: completion.completedAt, source: "completed_at" };
  const comment = firstDoneCommentAt(comments, nonce);
  return { at: comment, source: comment === null ? null : "done_comment" };
}

export function completionRunIds(comments: readonly CommentEvidence[], nonce: string, completion?: CompletionEvidence | null): string[] {
  const anchor = completedAtAnchor(completion, comments, nonce).at;
  const summaries = comments.filter(comment => anchor !== null && typeof comment.createdAt === "number" && comment.createdAt >= anchor
    && comment.body.includes(doneMarker(nonce)) && comment.runId).map(comment => comment.runId!);
  if (hasDispositions(completion)) {
    const byId = new Map(completion.runs.flatMap(run => run.runId ? [[run.runId, run] as const] : []));
    const reportedAt = (runId: string) => {
      const run = byId.get(runId);
      if (run?.acceptedDisposition === "done" && run.acceptedAt !== null) return run.acceptedAt;
      const posted = comments.filter(comment => comment.runId === runId && typeof comment.createdAt === "number").map(comment => comment.createdAt!);
      return posted.length ? Math.min(...posted) : run?.startedAt ?? Number.POSITIVE_INFINITY;
    };
    const accepted = completion.runs.filter(run => run.acceptedDisposition === "done" && run.runId).map(run => run.runId!);
    const ordered = [...new Set([...accepted, ...summaries])].sort((a, b) => reportedAt(a) - reportedAt(b));
    return ordered.filter((runId, index) => index === 0 || !byId.get(runId)?.answersFollowUp);
  }
  return [...new Set([...comments.filter(comment => isDoneComment(comment.body, nonce) && comment.runId).map(comment => comment.runId!), ...summaries])];
}

export function doneCommentsBeforeCompletion(comments: readonly CommentEvidence[], nonce: string, completion?: CompletionEvidence | null):
  Array<{ runId: string; disposition: string }> {
  if (!hasDispositions(completion)) return [];
  const dispositions = new Map(completion.runs.flatMap(run => run.runId ? [[run.runId, run.acceptedDisposition] as const] : []));
  return [...new Set(comments.filter(comment => isDoneComment(comment.body, nonce) && comment.runId).map(comment => comment.runId!))]
    .flatMap(runId => { const disposition = dispositions.get(runId); return disposition && disposition !== "done" ? [{ runId, disposition }] : []; });
}

export function isDoneComment(body: string, nonce: string): boolean {
  return body.trim().replace(/\.$/, "").replace(/^`+|`+$/g, "").trim() === doneMarker(nonce);
}

export function followUpComment(nonce: string): string {
  return `Additional requirement: include the line \`${followUpMarker(nonce)}\` on its own line in this task's \`ledger\` document. Keep going with your rounds: a round whose ROUND line is already in the ledger file is finished, and a round without one must still be run.`;
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
  const comments = artifacts.stagingMix?.comments ?? artifacts.agentComments.map(body => ({ body, runId: null }));
  const doneComments = comments.filter(comment => isDoneComment(comment.body, nonce)).length;
  const completionRuns = completionRunIds(comments, nonce, artifacts.stagingMix?.completion);
  const followUp = artifacts.stagingMix?.followUp ?? null;
  const children = (artifacts.children ?? []).filter(child => (child.title ?? "").includes(nonce));
  const checks: OracleResult["checks"] = [
    { name: "issue_done", ok: artifacts.issueStatus === "done", detail: `status=${artifacts.issueStatus ?? "unknown"}` },
    { name: "ledger_rounds_verified", ok: own.verified, detail: own.detail },
    { name: "done_comment_posted", ok: doneComments >= 1, detail: `comments=${doneComments}` },
    { name: "rounds_once", ok: own.duplicates === 0, detail: `duplicates=${own.duplicates}` },
    { name: "done_comment_once", ok: doneComments <= 1, detail: `comments=${doneComments}` },
    artifacts.stagingMix?.commentsUnreadable ? { name: "completion_once", ok: false, detail: "unreadable: the task's comments could not be read" }
      : { name: "completion_once", ok: completionRuns.length <= 1,
        detail: completionRuns.length > 1 ? `duplicate completion: runs ${completionRuns.map(id => id.slice(0, 8)).join(", ")} each reported completion` : `runs=${completionRuns.length}` },
  ];
  if (task.followUpAfterMs !== null) {
    const errors = artifacts.stagingMix?.followUpErrors ?? [];
    checks.push({ name: "follow_up_posted", ok: Boolean(followUp?.commentId),
      detail: followUp?.commentId ? `comment ${followUp.commentId}` : `never posted${errors.length ? `; errors: ${errors.slice(-3).join(" | ")}` : ""}` });
  }
  const afterEnd = artifacts.stagingMix?.afterEndFollowUps ?? [];
  const range = task.followUpAfterMs !== null ? followUpAfterEndRange() : null;
  if (range || afterEnd.length) {
    const replies = artifacts.stagingMix?.comments ?? [];
    const unanswered = afterEnd.filter(entry => !replies.some(comment => comment.createdAt != null && comment.createdAt >= entry.at));
    checks.push({ name: "after_end_follow_ups_served",
      ok: afterEnd.length >= (range?.count ?? 1) && unanswered.length === 0 && (ledger ?? "").includes(followUpMarker(nonce)),
      detail: `posted=${afterEnd.length}/${range?.count ?? afterEnd.length}; unanswered=${unanswered.map(entry => entry.commentId).join(", ") || "none"}` });
  }
  if (followUp?.commentId && followUp.duringRun) {
    checks.push({ name: "follow_up_served", ok: (ledger ?? "").includes(followUpMarker(nonce)),
      detail: `posted ${new Date(followUp.at).toISOString()}${followUp.inOverlap ? " in overlap" : ""}` });
  }
  if (task.subtasks > 0) {
    checks.push({ name: "subtasks_once", ok: children.length <= task.subtasks, detail: `subtasks=${children.length}/${task.subtasks}` });
    let childDuplicates = 0;
    for (let part = 1; part <= task.subtasks; part += 1) {
      const nonceOf = childNonce(nonce, part);
      const child = children.filter(candidate => (candidate.title ?? "").includes(nonceOf));
      const results = child.map(candidate => ({ candidate, result: verifyLedger(nonceOf, SUBTASK_ROUNDS, candidate.documents.ledger) }));
      const best = results.find(entry => entry.candidate.status === "done" && entry.result.verified) ?? results[0];
      childDuplicates += results.reduce((sum, entry) => sum + entry.result.duplicates, 0);
      const lastHash = expectedRoundHash(nonceOf, SUBTASK_ROUNDS);
      checks.push({ name: `subtask_${part}_done`, ok: Boolean(best && best.candidate.status === "done" && best.result.verified),
        detail: best ? `status=${best.candidate.status} ${best.result.detail}` : "missing" });
      checks.push({ name: `parent_read_subtask_${part}`, ok: (ledger ?? "").includes(childLine(part, lastHash)), detail: childLine(part, lastHash) });
    }
    checks.push({ name: "subtask_rounds_once", ok: childDuplicates === 0, detail: `duplicates=${childDuplicates}` });
  }
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}

export function stagingMixBudgetMs(task: StagingMixTask): number {
  const turnMs = task.rounds * ROUND_SECONDS * 1_000;
  const afterEnd = task.followUpAfterMs !== null ? followUpAfterEndRange() : null;
  return Math.round(turnMs * 1.5) + 20 * 60_000 + (task.subtasks ? 20 * 60_000 : 0)
    + (afterEnd ? afterEnd.count * (afterEnd.maxMs + turnMs) : 0);
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

export function followUpAfterEndRange(environment: NodeJS.ProcessEnv = process.env): { minMs: number; maxMs: number; count: number } | null {
  const raw = environment.RESTART_CHAOS_MIX_FOLLOW_UP_AFTER_END_MS;
  if (!raw) return null;
  const [low, high] = parseRange(raw, "RESTART_CHAOS_MIX_FOLLOW_UP_AFTER_END_MS", 0, 3_600_000);
  const count = whole(environment.RESTART_CHAOS_MIX_FOLLOW_UP_COUNT, "RESTART_CHAOS_MIX_FOLLOW_UP_COUNT", 2, 1, 10);
  return { minMs: low, maxMs: high, count };
}

export async function stagingMixStep(input: StagingMixStepInput): Promise<void> {
  const { record, task, sample, now } = input;
  const state = record.stagingMix ??= {};
  if (!sample.reachable || !record.issueId || record.createdAt === null) return;
  const overlap = insideOverlapWindow(now, { faultInProgress: input.faultInProgress, reachable: sample.reachable });
  const running = (sample.runs ?? []).some(run => run.status === "running");
  const afterEnd = followUpAfterEndRange();
  if (afterEnd && task.followUpAfterMs !== null) {
    const posted = state.afterEndFollowUps ??= [];
    const runs = sample.runs ?? [];
    const active = runs.some(run => ACTIVE.has(run.status));
    const lastEnd = Math.max(0, ...runs.map(run => Date.parse(run.finishedAt ?? "") || 0));
    if (!active && lastEnd > 0 && posted.length < afterEnd.count && !posted.some(entry => entry.afterRunEndAt === lastEnd)) {
      const span = afterEnd.maxMs - afterEnd.minMs;
      const delay = afterEnd.minMs + (span > 0 ? (Number.parseInt(input.nonce.slice(0, 6), 16) * (posted.length + 1)) % (span + 1) : 0);
      if (now >= lastEnd + delay) {
        const index = posted.length;
        let commentId: string | null = null; let error: string | null = null;
        try {
          const comment = await input.api.post<{ id?: string }>(`/api/issues/${record.issueId}/comments`, { body: followUpComment(input.nonce),
            clientRequestId: followUpRequestId(record.issueId, `${input.nonce}-after-end-${index}`) });
          commentId = typeof comment?.id === "string" ? comment.id : null;
          if (!commentId) error = "the comment response had no id";
        } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
        if (commentId) posted.push({ afterRunEndAt: lastEnd, at: now, delayMs: now - lastEnd, commentId });
        else (state.followUpErrors ??= []).push(error!);
        input.note("staging_mix_follow_up_after_end", { index, delayMs: now - lastEnd, commentId, error });
        if (commentId && !state.followUp) state.followUp = { at: now, commentId, duringRun: false, inOverlap: overlap, error: null };
      }
    }
  } else if (task.followUpAfterMs !== null && !state.followUp && running) {
    const plannedAt = record.createdAt + task.followUpAfterMs;
    const latestAt = Math.min(plannedAt + task.holdMs, record.createdAt + Math.round(task.rounds * ROUND_SECONDS * 1_000 * 0.85));
    if (now >= plannedAt && (overlap || now >= latestAt)) {
      const followUp: NonNullable<StagingMixRecord["followUp"]> = { at: now, commentId: null, duringRun: true, inOverlap: overlap, error: null };
      try {
        const comment = await input.api.post<{ id?: string }>(`/api/issues/${record.issueId}/comments`, { body: followUpComment(input.nonce),
          clientRequestId: followUpRequestId(record.issueId, input.nonce) });
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
  noteRetryBanner(state, retryShown(sample), now, latestFailureCode(sample));
  if (!retryOffered(sample) || !retryDue(record)) {
    if (!retryOffered(sample)) state.retrySeenAt = null;
    return;
  }
  state.retrySeenAt ??= now;
  if (!overlap || !task.retryDuringWave) return;
  (state.retries ??= []).push({ at: now, inOverlap: true });
  input.note("staging_mix_retry_in_overlap", { waitedMs: now - state.retrySeenAt });
  await input.retry(sample, now);
}

export function retryShown(sample: Pick<TaskSample, "reachable" | "issueStatus" | "interruption">): boolean {
  return sample.reachable && sample.issueStatus !== "done" && Boolean(sample.interruption?.canRetry);
}

export function latestFailureCode(sample: Pick<TaskSample, "runs">): string | null {
  const failed = (sample.runs ?? []).filter(run => run.status === "failed" || run.status === "timed_out" || run.errorCode)
    .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
  return failed[0]?.errorCode ?? failed[0]?.failureCause ?? null;
}

export function noteRetryBanner(state: StagingMixRecord, shown: boolean, now: number, errorCode: string | null): void {
  const banner = state.retryBanner;
  if (!shown) {
    if (banner?.visibleSince != null) { banner.shownMs += now - banner.visibleSince; banner.visibleSince = null; }
    return;
  }
  if (!banner) { state.retryBanner = { firstShownAt: now, lastShownAt: now, shownMs: 0, visibleSince: now, errorCode }; return; }
  banner.lastShownAt = now;
  banner.visibleSince ??= now;
  banner.errorCode = errorCode ?? banner.errorCode;
}

export function bannerShownMs(banner: RetryBanner, now: number): number {
  return banner.shownMs + (banner.visibleSince === null ? 0 : now - banner.visibleSince);
}

export function collectStagingMixArtifacts(record: TaskRecord,
  rows: ReadonlyArray<{ body?: unknown; authorAgentId?: unknown; createdByRunId?: unknown; createdAt?: unknown }> | null): StagingMixArtifacts {
  const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  return { followUp: record.stagingMix?.followUp ?? null, followUpErrors: record.stagingMix?.followUpErrors ?? [], retries: record.stagingMix?.retries ?? [],
    ...(record.stagingMix?.completion ? { completion: record.stagingMix.completion } : {}),
    ...(record.stagingMix?.afterEndFollowUps?.length ? { afterEndFollowUps: record.stagingMix.afterEndFollowUps } : {}),
    ...(rows ? { comments: rows.filter(row => row.authorAgentId).map(row => ({ body: String(row.body ?? ""),
      runId: typeof row.createdByRunId === "string" ? row.createdByRunId : null, createdAt: time(row.createdAt) })) }
      : { commentsUnreadable: true }) };
}
