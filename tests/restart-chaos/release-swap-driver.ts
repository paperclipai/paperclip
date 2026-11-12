import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ChaosApi } from "./api.js";
import { workloadDefinitions } from "./workloads.js";
import { RELEASE_SWAP_LATE_LEAD_MS, type ReleaseSwapOptions } from "./release-swap-schedule.js";
import type { AdapterId } from "./types.js";
import type { Db } from "../../packages/db/src/index.js";

export type SwapPhase = "before_spawn" | "spawned" | "switched" | "stopping" | "stopped";

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
  evidence: SwapEvidence | null;
}

export interface SwapRunReader {
  runsSince(companyId: string, since: number): Promise<Array<Omit<RunTrace, "samples"> & RunSampleRow>>;
}

const PREPARING_STAGES = new Set(["preparing", "dispatching", "dispatch"]);
const LATE_WINDOW_MS = 60_000;
const SAMPLE_MS = 2_000;
const SAMPLE_TAIL_MS = 60_000;

export function isPreparing(sample: RunSampleRow): boolean {
  if (sample.status !== "running") return false;
  if (sample.executionStage) return PREPARING_STAGES.has(sample.executionStage);
  return sample.lastOutputSeq === 0;
}

function firstOwner(trace: RunTrace): number | null {
  return trace.samples.find(sample => sample.ownerPid !== null)?.ownerPid ?? null;
}

function startedBy(trace: RunTrace, swap: Pick<SwapRecord, "fromPid" | "toPid">): "old" | "new" | "unknown" {
  const owner = firstOwner(trace);
  if (owner !== null && owner === swap.fromPid) return "old";
  if (owner !== null && owner === swap.toPid) return "new";
  return "unknown";
}

export function recoveryWindow(swap: Pick<SwapRecord, "incomingPhases" | "spawnedAt" | "switchedAt">): { from: number; to: number } | null {
  const recovering = swap.incomingPhases.find(phase => phase.phase === "recovering")?.at ?? null;
  const ready = swap.incomingPhases.find(phase => phase.phase === "ready")?.at ?? swap.switchedAt;
  const from = recovering ?? swap.spawnedAt;
  if (from === null || ready === null) return null;
  return { from, to: Math.max(from, ready) };
}

function preparationSpan(trace: RunTrace): { from: number; to: number } | null {
  const preparing = trace.samples.filter(isPreparing);
  if (!preparing.length) return null;
  const from = trace.startedAt ?? preparing[0]!.at;
  return { from: Math.min(from, preparing[0]!.at), to: preparing[preparing.length - 1]!.at };
}

export function swapEvidence(swap: SwapRecord): SwapEvidence {
  const traces = Object.values(swap.runs);
  const findings: string[] = [];
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
  if (!window) findings.push("the incoming server's startup recovery window was not observed");
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
  apiFor?: (baseUrl: string) => ChaosApi;
}

export class ReleaseSwapDriver {
  readonly swaps: SwapRecord[] = [];
  readonly plugins: SwapPlugin[] = [];
  launchOpen = false;
  private current: SwapRecord | null = null;
  private background: Promise<unknown>[] = [];
  private probeCount = 0;

  constructor(private readonly input: ReleaseSwapDriverInput) {}

  readonly hook = async (info: SwapPhaseInfo): Promise<string | void> => {
    let swap = this.current;
    if (info.phase === "before_spawn" || !swap) {
      swap = { index: this.swaps.length + 1, faultId: info.faultId, fromPid: info.fromPid, toPid: null, fromUrl: info.fromUrl, toUrl: null,
        serverRoot: null, requestedAt: info.at, spawnedAt: null, switchedAt: null, overlapEndsAt: null, stopRequestedAt: null, stoppedAt: null,
        incomingPhases: [], probes: [], runs: {}, sampleErrors: 0, plugins: [], evidence: null };
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
      const wait = swap.overlapEndsAt! - RELEASE_SWAP_LATE_LEAD_MS - latency - Date.now();
      if (wait > 0) await delay(wait);
      if (swap.stopRequestedAt === null) await this.probe(swap, "late");
    })());
  }

  private startLatency(swap: SwapRecord): number | null {
    const latencies = swap.probes.flatMap(probe => {
      const trace = Object.values(swap.runs).find(candidate => candidate.issueId === probe.issueId && candidate.startedAt !== null);
      return trace && probe.createdAt !== null ? [Math.max(0, trace.startedAt! - probe.createdAt)] : [];
    });
    return latencies.length ? latencies.sort((left, right) => left - right)[Math.floor(latencies.length / 2)]! : null;
  }

  private async watchIncoming(swap: SwapRecord): Promise<void> {
    let prepProbes = 1;
    while (swap.toUrl && swap.stopRequestedAt === null) {
      const phase = await fetch(`${swap.toUrl}/api/ready`, { signal: AbortSignal.timeout(1_000), cache: "no-store" })
        .then(async response => String(((await response.json()) as { status?: string }).status ?? response.status)).catch(() => "unreachable");
      const last = swap.incomingPhases[swap.incomingPhases.length - 1]?.phase;
      if (phase !== last) {
        swap.incomingPhases.push({ phase, at: Date.now() });
        if (phase === "recovering" && prepProbes < 3) { prepProbes += 1; this.background.push(this.probe(swap, "prep")); }
      }
      if (phase === "ready") return;
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
      if (swap.stoppedAt !== null && Date.now() > swap.stoppedAt + SAMPLE_TAIL_MS) break;
      await delay(SAMPLE_MS);
    }
    swap.evidence = swapEvidence(swap);
    this.input.record("release_swap_evidence", { swap: swap.index, faultId: swap.faultId, lateOk: swap.evidence.lateOk, prepOk: swap.evidence.prepOk,
      lateRunId: swap.evidence.lateRunId, lateStartOffsetMs: swap.evidence.lateStartOffsetMs, prepRunIds: swap.evidence.prepRunIds,
      startedByOld: swap.evidence.startedByOld.length, startedByNew: swap.evidence.startedByNew.length, findings: swap.evidence.findings });
  }

  private async probe(swap: SwapRecord, kind: ProbeRecord["kind"]): Promise<void> {
    const adapters = this.input.adapters.filter(adapter => this.input.agents[adapter]);
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
        status: "todo", priority: "medium", assigneeAgentId: this.input.agents[adapter]!.id });
      probe.issueId = String(issue.id);
      probe.identifier = issue.identifier ?? null;
      probe.createdAt = Date.now();
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
    }
    this.input.record("release_swap_probe", { swap: swap.index, kind, adapter, issueId: probe.issueId, identifier: probe.identifier, error: probe.error });
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.background);
  }
}

export function pgRunReader(db: Db): SwapRunReader {
  const ms = (value: unknown) => value === null || value === undefined ? null : Number(value);
  return {
    async runsSince(companyId, since) {
      const rows = await db.$client.unsafe(
        `select r.id::text as "runId", r.issue_id::text as "issueId", r.status, r.error_code as "errorCode",
                floor(extract(epoch from r.created_at) * 1000) as "createdAt", floor(extract(epoch from r.started_at) * 1000) as "startedAt",
                floor(extract(epoch from r.finished_at) * 1000) as "finishedAt", ci.pid as "ownerPid", r.execution_stage as "executionStage",
                r.native_phase as "nativePhase", r.last_output_seq as "lastOutputSeq", floor(extract(epoch from clock_timestamp()) * 1000) as "at"
           from heartbeat_runs r left join controller_instances ci on ci.boot_id = r.controller_boot_id::text
          where r.company_id::text = $1 and (r.created_at >= to_timestamp($2::double precision / 1000) or r.status in ('queued', 'running'))`,
        [companyId, since]) as Array<Record<string, unknown>>;
      return rows.map(row => ({ runId: String(row.runId), issueId: row.issueId === null ? null : String(row.issueId), status: String(row.status),
        errorCode: row.errorCode === null ? null : String(row.errorCode), createdAt: ms(row.createdAt), startedAt: ms(row.startedAt),
        finishedAt: ms(row.finishedAt), ownerPid: ms(row.ownerPid), executionStage: row.executionStage === null ? null : String(row.executionStage),
        nativePhase: row.nativePhase === null ? null : String(row.nativePhase), lastOutputSeq: Number(row.lastOutputSeq ?? 0), at: Number(row.at) }));
    },
  };
}
