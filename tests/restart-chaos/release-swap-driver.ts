import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ChaosApi } from "./api.js";
import { workloadDefinitions } from "./workloads.js";
import { RELEASE_SWAP_LATE_LEAD_MS, type ReleaseSwapOptions } from "./release-swap-schedule.js";
import type { AdapterId } from "./types.js";
import type { Db } from "../../packages/db/src/index.js";

export type SwapPhase = "before_spawn" | "spawned" | "switched" | "stopping" | "stopped";

export const SWAP_PHASE_MOMENT: Partial<Record<SwapPhase, string>> = {
  spawned: "incoming_spawned", switched: "traffic_switched", stopping: "outgoing_sigterm", stopped: "outgoing_exited",
};

export interface SwapPhaseInfo {
  faultId: string;
  phase: SwapPhase;
  at: number;
  fromUrl: string;
  toUrl: string | null;
  fromPid: number | null;
  toPid: number | null;
  overlapMs: number;
}

export interface SwapPlugin {
  name: string;
  onPhase(swap: SwapRecord, info: SwapPhaseInfo): Promise<string | void>;
}

export interface ProbeRecord {
  kind: "prep" | "late";
  adapter: AdapterId;
  nonce: string;
  requestedAt: number;
  createdAt: number | null;
  issueId: string | null;
  identifier: string | null;
  error: string | null;
}

export interface RunSampleRow {
  at: number;
  status: string;
  ownerPid: number | null;
  executionStage: string | null;
  nativePhase: string | null;
  lastOutputSeq: number;
}

export interface RunTrace {
  runId: string;
  issueId: string | null;
  createdAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  errorCode: string | null;
  samples: RunSampleRow[];
}

export interface SwapEvidence {
  lateRunId: string | null;
  lateStartedBy: "old" | "new" | "unknown" | null;
  lateStartOffsetMs: number | null;
  lateOk: boolean;
  prepRunIds: string[];
  prepOk: boolean;
  recoveryWindow: { from: number; to: number } | null;
  startedByOld: string[];
  startedByNew: string[];
  findings: string[];
}

export interface SwapRecord {
  index: number;
  faultId: string;
  fromPid: number | null;
  toPid: number | null;
  fromUrl: string;
  toUrl: string | null;
  serverRoot: string | null;
  requestedAt: number;
  spawnedAt: number | null;
  switchedAt: number | null;
  overlapEndsAt: number | null;
  stopRequestedAt: number | null;
  stoppedAt: number | null;
  incomingPhases: Array<{ phase: string; at: number }>;
  probes: ProbeRecord[];
  runs: Record<string, RunTrace>;
  sampleErrors: number;
  plugins: Array<{ name: string; phase: SwapPhase; error: string | null }>;
  abandoned: string | null;
  evidence: SwapEvidence | null;
}

export interface SwapRunReader {
  runsSince(companyId: string, since: number): Promise<Array<Omit<RunTrace, "samples"> & RunSampleRow>>;
}

const PREPARING_STAGES = new Set(["preparing", "dispatching", "dispatch"]);
const LATE_WINDOW_MS = 60_000;
const SAMPLE_MS = 2_000;
const SAMPLE_TAIL_MS = 60_000;
const BOOT_SAMPLE_MS = 500;
export const SWAP_ABANDON_AFTER_MS = 15 * 60_000;
export const PREP_INTERVAL_MS = 2_000;
export const PREP_PROBE_CAP = 6;
export const PROBE_AGENT_CONCURRENCY = 10;

export function isPreparing(sample: RunSampleRow): boolean {
  if (sample.status !== "running") return false;
  if (sample.executionStage) return PREPARING_STAGES.has(sample.executionStage);
  return sample.lastOutputSeq === 0;
}

function firstOwner(trace: RunTrace): number | null {
  return trace.samples.find(sample => sample.ownerPid !== null)?.ownerPid ?? null;
}

export function incomingReadyAt(swap: Pick<SwapRecord, "incomingPhases">, switchedAt: number): number {
  const watched = swap.incomingPhases.find(phase => phase.phase === "ready")?.at;
  return watched === undefined ? switchedAt : Math.min(watched, switchedAt);
}

export function startedBy(trace: RunTrace, swap: Pick<SwapRecord, "fromPid" | "toPid">): "old" | "new" | "unknown" {
  const owner = firstOwner(trace);
  if (owner !== null && owner === swap.fromPid) return "old";
  if (owner !== null && owner === swap.toPid) return "new";
  return "unknown";
}

export function recoveryWindow(swap: Pick<SwapRecord, "incomingPhases" | "spawnedAt" | "switchedAt">): { from: number; to: number } | null {
  const recovering = swap.incomingPhases.find(phase => phase.phase === "recovering")?.at ?? null;
  const ready = swap.incomingPhases.find(phase => phase.phase === "ready")?.at ?? swap.switchedAt;
  if (recovering === null || ready === null) return null;
  return { from: recovering, to: Math.max(recovering, ready) };
}

function preparationSpan(trace: RunTrace): { from: number; to: number } | null {
  const preparing = trace.samples.filter(isPreparing);
  if (!preparing.length) return null;
  const from = trace.startedAt ?? preparing[0]!.at;
  return { from: Math.min(from, preparing[0]!.at), to: preparing[preparing.length - 1]!.at };
}

export function swapEvidence(swap: SwapRecord): SwapEvidence {
  const traces = Object.values(swap.runs);
  const findings: string[] = swap.abandoned ? [`swap abandoned: ${swap.abandoned}`] : [];
  const windowStart = swap.spawnedAt ?? swap.requestedAt;
  const windowEnd = swap.stopRequestedAt ?? Number.POSITIVE_INFINITY;
  const startedInOverlap = traces.filter(trace => trace.startedAt !== null && trace.startedAt >= windowStart && trace.startedAt <= windowEnd);
  const startedByOld = startedInOverlap.filter(trace => startedBy(trace, swap) === "old").map(trace => trace.runId);
  const startedByNew = startedInOverlap.filter(trace => startedBy(trace, swap) === "new").map(trace => trace.runId);
  const late = swap.probes.find(probe => probe.kind === "late" && probe.issueId);
  const lateTrace = late ? traces.filter(trace => trace.issueId === late.issueId && trace.startedAt !== null)
    .sort((left, right) => left.startedAt! - right.startedAt!)[0] ?? null : null;
  const lateStartedBy = lateTrace ? startedBy(lateTrace, swap) : null;
  const lateStartOffsetMs = lateTrace && swap.stopRequestedAt !== null ? lateTrace.startedAt! - swap.stopRequestedAt : null;
  const lateOk = lateStartedBy === "old" && lateStartOffsetMs !== null && lateStartOffsetMs <= 0 && lateStartOffsetMs >= -LATE_WINDOW_MS;
  if (!late) findings.push("late probe was not created on the outgoing server");
  else if (!lateTrace) findings.push(`late probe ${late.identifier ?? late.issueId} had no run started before sampling ended`);
  else if (lateStartedBy !== "old") findings.push(`late probe run ${lateTrace.runId} was started by the ${lateStartedBy} server`);
  else if (!lateOk) findings.push(`late probe run ${lateTrace.runId} started ${Math.round((lateStartOffsetMs ?? 0) / 1000)} s from the outgoing server's SIGTERM`);
  const window = recoveryWindow(swap);
  const prepRunIds = window ? traces.filter(trace => {
    if (startedBy(trace, swap) !== "old") return false;
    const span = preparationSpan(trace);
    return span !== null && span.from <= window.to && span.to >= window.from;
  }).map(trace => trace.runId) : [];
  if (!window) findings.push("the incoming server's startup recovery pass was not observed (no `recovering` phase before `ready`)");
  else if (!prepRunIds.length) findings.push("no run of the outgoing server was seen in preparation during the incoming server's startup recovery");
  return { lateRunId: lateTrace?.runId ?? null, lateStartedBy, lateStartOffsetMs, lateOk, prepRunIds, prepOk: prepRunIds.length > 0,
    recoveryWindow: window, startedByOld, startedByNew, findings };
}

export function mergeRunSample(runs: Record<string, RunTrace>, row: Omit<RunTrace, "samples"> & RunSampleRow): void {
  const trace = runs[row.runId] ??= { runId: row.runId, issueId: row.issueId, createdAt: row.createdAt, startedAt: row.startedAt,
    finishedAt: row.finishedAt, errorCode: row.errorCode, samples: [] };
  Object.assign(trace, { issueId: row.issueId, createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt, errorCode: row.errorCode });
  const sample: RunSampleRow = { at: row.at, status: row.status, ownerPid: row.ownerPid, executionStage: row.executionStage,
    nativePhase: row.nativePhase, lastOutputSeq: row.lastOutputSeq };
  const last = trace.samples[trace.samples.length - 1];
  if (last && last.status === sample.status && last.ownerPid === sample.ownerPid && last.executionStage === sample.executionStage
    && last.nativePhase === sample.nativePhase && (last.lastOutputSeq > 0) === (sample.lastOutputSeq > 0)) {
    if (isPreparing(sample)) trace.samples.push(sample);
    return;
  }
  trace.samples.push(sample);
}

export interface ReleaseSwapDriverInput {
  options: ReleaseSwapOptions;
  companyId: string;
  adapters: readonly AdapterId[];
  agents: Partial<Record<AdapterId, { id: string }>>;
  reader: SwapRunReader;
  record: (kind: string, data: Record<string, unknown>) => void;
  apiFor?: (baseUrl: string) => Pick<ChaosApi, "post">;
  sampleMs?: number;
  abandonAfterMs?: number;
  probeAgents?: Partial<Record<AdapterId, { id: string }>>;
  prepIntervalMs?: number;
  prepProbeCap?: number;
}

export class ReleaseSwapDriver {
  readonly swaps: SwapRecord[] = [];
  readonly plugins: SwapPlugin[] = [];
  launchOpen = false;
  private current: SwapRecord | null = null;
  private background: Promise<unknown>[] = [];
  private probeCount = 0;
  private closed = false;

  constructor(private readonly input: ReleaseSwapDriverInput) {}

  readonly hook = async (info: SwapPhaseInfo): Promise<string | void> => {
    let swap = this.current;
    if (info.phase === "before_spawn" || !swap) {
      if (swap) this.abandon(swap, `a new swap (${info.faultId}) began before this one stopped the outgoing server`);
      swap = { index: this.swaps.length + 1, faultId: info.faultId, fromPid: info.fromPid, toPid: null, fromUrl: info.fromUrl, toUrl: null,
        serverRoot: null, requestedAt: info.at, spawnedAt: null, switchedAt: null, overlapEndsAt: null, stopRequestedAt: null, stoppedAt: null,
        incomingPhases: [], probes: [], runs: {}, sampleErrors: 0, plugins: [], abandoned: null, evidence: null };
      this.swaps.push(swap);
      this.current = swap;
    }
    swap.toUrl = info.toUrl ?? swap.toUrl;
    swap.toPid = info.toPid ?? swap.toPid;
    let root: string | void = undefined;
    for (const plugin of this.plugins) {
      try {
        const chosen = await plugin.onPhase(swap, info);
        if (typeof chosen === "string") root = chosen;
        swap.plugins.push({ name: plugin.name, phase: info.phase, error: null });
      } catch (error) {
        swap.plugins.push({ name: plugin.name, phase: info.phase, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (typeof root === "string") swap.serverRoot = root;
    this.input.record("release_swap_phase", { swap: swap.index, faultId: info.faultId, phase: info.phase, fromPid: info.fromPid, toPid: info.toPid,
      ...(root ? { serverRoot: root } : {}) });
    const moment = SWAP_PHASE_MOMENT[info.phase];
    if (info.phase === "switched") this.input.record("swap_incoming_ready", { swap: swap.index, faultId: info.faultId, at: new Date(incomingReadyAt(swap, info.at)).toISOString(), toPid: info.toPid, confirmedBy: "supervisor" });
    if (moment) this.input.record(`swap_${moment}`, { swap: swap.index, faultId: info.faultId, at: new Date(info.at).toISOString(), fromPid: info.fromPid, toPid: info.toPid });
    if (info.phase === "spawned") this.onSpawned(swap, info);
    if (info.phase === "switched") this.onSwitched(swap, info);
    if (info.phase === "stopping") { swap.stopRequestedAt = info.at; this.launchOpen = false; }
    if (info.phase === "stopped") { swap.stoppedAt = info.at; this.current = null; }
    return root;
  };

  private onSpawned(swap: SwapRecord, info: SwapPhaseInfo): void {
    swap.spawnedAt = info.at;
    this.background.push(this.probe(swap, "prep"));
    this.background.push(this.watchIncoming(swap));
    this.background.push(this.sample(swap));
  }

  private onSwitched(swap: SwapRecord, info: SwapPhaseInfo): void {
    swap.switchedAt = info.at;
    swap.overlapEndsAt = info.at + info.overlapMs;
    this.launchOpen = true;
    this.background.push((async () => {
      const latency = this.startLatency(swap) ?? 5_000;
      for (let wait = swap.overlapEndsAt! - RELEASE_SWAP_LATE_LEAD_MS - latency - Date.now(); wait > 0 && !this.closed && swap.abandoned === null;
        wait = swap.overlapEndsAt! - RELEASE_SWAP_LATE_LEAD_MS - latency - Date.now()) await delay(Math.min(1_000, wait));
      if (swap.stopRequestedAt === null && swap.abandoned === null) await this.probe(swap, "late");
    })());
  }

  private startLatency(swap: SwapRecord): number | null {
    const latencies = swap.probes.flatMap(probe => {
      const trace = Object.values(swap.runs).find(candidate => candidate.issueId === probe.issueId && candidate.startedAt !== null);
      return trace && probe.createdAt !== null ? [Math.max(0, trace.startedAt! - probe.createdAt)] : [];
    });
    return latencies.length ? latencies.sort((left, right) => left - right)[Math.floor(latencies.length / 2)]! : null;
  }

  private ended(swap: SwapRecord): boolean {
    if (swap.abandoned === null && swap.stoppedAt === null && Date.now() > swap.requestedAt + (this.input.abandonAfterMs ?? this.input.options.overlapMs + SWAP_ABANDON_AFTER_MS)) {
      this.abandon(swap, "the outgoing server was not stopped within the swap's time bound (the incoming server failed or the harness stopped)");
    }
    return swap.abandoned !== null || (this.closed && (swap.stoppedAt === null || Date.now() > swap.stoppedAt + SAMPLE_TAIL_MS));
  }

  abandon(swap: SwapRecord, reason: string): void {
    if (swap.abandoned !== null || swap.stoppedAt !== null) return;
    swap.abandoned = reason;
    if (this.current === swap) { this.current = null; this.launchOpen = false; }
    this.input.record("release_swap_abandoned", { swap: swap.index, faultId: swap.faultId, reason });
  }

  private async watchIncoming(swap: SwapRecord): Promise<void> {
    let prepProbes = 1;
    let lastProbeAt = Date.now();
    const interval = this.input.prepIntervalMs ?? PREP_INTERVAL_MS;
    const cap = this.input.prepProbeCap ?? PREP_PROBE_CAP;
    while (swap.toUrl && swap.stopRequestedAt === null && !this.ended(swap)) {
      const phase = await fetch(`${swap.toUrl}/api/ready`, { signal: AbortSignal.timeout(1_000), cache: "no-store" })
        .then(async response => String(((await response.json()) as { status?: string }).status ?? response.status)).catch(() => "unreachable");
      const last = swap.incomingPhases[swap.incomingPhases.length - 1]?.phase;
      if (phase !== last) {
        swap.incomingPhases.push({ phase, at: Date.now() });
        if (phase === "recovering" && prepProbes < cap) { prepProbes += 1; lastProbeAt = Date.now(); this.background.push(this.probe(swap, "prep")); }
      }
      if (phase === "ready") return;
      if (prepProbes < cap && Date.now() - lastProbeAt >= interval) { prepProbes += 1; lastProbeAt = Date.now(); this.background.push(this.probe(swap, "prep")); }
      await delay(250);
    }
  }

  private async sample(swap: SwapRecord): Promise<void> {
    const since = swap.requestedAt;
    for (;;) {
      try {
        const rows = await this.input.reader.runsSince(this.input.companyId, since);
        for (const row of rows) mergeRunSample(swap.runs, row);
      } catch {
        swap.sampleErrors += 1;
      }
      if (this.ended(swap) || (swap.stoppedAt !== null && Date.now() > swap.stoppedAt + SAMPLE_TAIL_MS)) break;
      const booting = swap.switchedAt === null && !swap.incomingPhases.some(phase => phase.phase === "ready");
      await delay(this.input.sampleMs ?? (booting ? BOOT_SAMPLE_MS : SAMPLE_MS));
    }
    swap.evidence = swapEvidence(swap);
    this.input.record("release_swap_evidence", { swap: swap.index, faultId: swap.faultId, lateOk: swap.evidence.lateOk, prepOk: swap.evidence.prepOk,
      lateRunId: swap.evidence.lateRunId, lateStartOffsetMs: swap.evidence.lateStartOffsetMs, prepRunIds: swap.evidence.prepRunIds,
      startedByOld: swap.evidence.startedByOld.length, startedByNew: swap.evidence.startedByNew.length, findings: swap.evidence.findings });
  }

  private async probe(swap: SwapRecord, kind: ProbeRecord["kind"]): Promise<void> {
    const agents = this.input.probeAgents ?? this.input.agents;
    const adapters = this.input.adapters.filter(adapter => agents[adapter]);
    const adapter = adapters[this.probeCount % Math.max(1, adapters.length)]!;
    this.probeCount += 1;
    const nonce = randomBytes(4).toString("hex");
    const probe: ProbeRecord = { kind, adapter, nonce, requestedAt: Date.now(), createdAt: null, issueId: null, identifier: null, error: null };
    swap.probes.push(probe);
    const definition = workloadDefinitions.A1;
    const api = this.input.apiFor?.(swap.fromUrl) ?? new ChaosApi(swap.fromUrl);
    try {
      const issue = await api.post<{ id: string; identifier?: string | null }>(`/api/companies/${this.input.companyId}/issues`, {
        title: `Release swap ${swap.index} ${kind} probe ${nonce}`, description: definition.description(nonce),
        status: "todo", priority: "medium", assigneeAgentId: agents[adapter]!.id });
      probe.issueId = String(issue.id);
      probe.identifier = issue.identifier ?? null;
      probe.createdAt = Date.now();
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
    }
    this.input.record("release_swap_probe", { swap: swap.index, kind, adapter, issueId: probe.issueId, identifier: probe.identifier, error: probe.error });
  }

  async drain(cancelled: () => boolean = () => false): Promise<void> {
    this.closed = true;
    if (this.current) this.abandonIfStalled(this.current);
    const settled = Promise.allSettled(this.background);
    while (!cancelled()) {
      const done = await Promise.race([settled.then(() => true), delay(1_000).then(() => false)]);
      if (done) return;
    }
    for (const swap of this.swaps) this.abandon(swap, "the harness was interrupted");
  }

  private abandonIfStalled(swap: SwapRecord): void {
    if (swap.stopRequestedAt === null) this.abandon(swap, "the wave finished before the swap stopped the outgoing server");
  }
}

export const RUN_OWNER_BOOT_ID = "coalesce(r.controller_boot_id::text, f.controller_boot_id, f.lease_holder->>'bootId')";

export function pgRunReader(db: Db): SwapRunReader {
  const ms = (value: unknown) => value === null || value === undefined ? null : Number(value);
  return {
    async runsSince(companyId, since) {
      const rows = await db.$client.unsafe(
        `select r.id::text as "runId", r.issue_id::text as "issueId", r.status, r.error_code as "errorCode",
                floor(extract(epoch from r.created_at) * 1000) as "createdAt", floor(extract(epoch from r.started_at) * 1000) as "startedAt",
                floor(extract(epoch from r.finished_at) * 1000) as "finishedAt", ci.pid as "ownerPid", r.execution_stage as "executionStage",
                r.native_phase as "nativePhase", r.last_output_seq as "lastOutputSeq", floor(extract(epoch from clock_timestamp()) * 1000) as "at"
           from heartbeat_runs r left join native_run_finalizations f on f.run_id = r.id
           left join controller_instances ci on ci.boot_id = ${RUN_OWNER_BOOT_ID}
          where r.company_id::text = $1 and (r.created_at >= to_timestamp($2::double precision / 1000) or r.status in ('queued', 'running'))`,
        [companyId, since]) as Array<Record<string, unknown>>;
      return rows.map(row => ({ runId: String(row.runId), issueId: row.issueId === null ? null : String(row.issueId), status: String(row.status),
        errorCode: row.errorCode === null ? null : String(row.errorCode), createdAt: ms(row.createdAt), startedAt: ms(row.startedAt),
        finishedAt: ms(row.finishedAt), ownerPid: ms(row.ownerPid), executionStage: row.executionStage === null ? null : String(row.executionStage),
        nativePhase: row.nativePhase === null ? null : String(row.nativePhase), lastOutputSeq: Number(row.lastOutputSeq ?? 0), at: Number(row.at) }));
    },
  };
}

export async function hireProbeAgents(api: Pick<ChaosApi, "post">, companyId: string,
  agents: Partial<Record<AdapterId, { id: string; name: string; body?: Record<string, unknown> }>>, maxConcurrentRuns: number):
  Promise<Partial<Record<AdapterId, { id: string; createdAt: number }>>> {
  const hired: Partial<Record<AdapterId, { id: string; createdAt: number }>> = {};
  for (const [adapter, source] of Object.entries(agents) as Array<[AdapterId, { id: string; name: string; body?: Record<string, unknown> }]>) {
    if (!source.body) continue;
    const runtimeConfig = (source.body.runtimeConfig ?? {}) as Record<string, unknown>;
    const created = await api.post<{ id: string }>(`/api/companies/${companyId}/agents`, { ...source.body, name: `${source.name} swap probe`,
      runtimeConfig: { ...runtimeConfig, heartbeat: { ...((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>), maxConcurrentRuns } } });
    hired[adapter] = { id: String(created.id), createdAt: Date.now() };
  }
  return hired;
}

export function homeCleanupPlugin(input: { temporaryRoot: string; freshHome: boolean; remove: (directory: string) => Promise<void>;
  diskUsageKb: (directory: string) => Promise<number | null>; record: (kind: string, data: Record<string, unknown>) => void }): SwapPlugin {
  return {
    name: "home-cleanup",
    async onPhase(swap, info) {
      if (info.phase !== "stopped") return;
      const generation = swap.index - 1;
      const removed = input.freshHome && generation >= 1 ? `${input.temporaryRoot}/home-g${generation}` : null;
      if (removed) await input.remove(removed);
      input.record("release_swap_disk", { swap: swap.index, removed, temporaryRootKb: await input.diskUsageKb(input.temporaryRoot) });
    },
  };
}
