import { readMetrics, type Clock, type Fetcher, type PaperclipClient } from "./client.ts";
import type { Options, Step } from "./config.ts";
import { evaluate, firstFailure, type CriterionResult, type ServerMetrics, type StepMetrics } from "./criteria.ts";
import { LIVE_RUN_STATUSES } from "./cleanup.ts";
import { AgentsNotReady, describeAgent, ensureAgents, waitForAgentsReady } from "./setup.ts";
import { distribution } from "./stats.ts";
import { mapLimit, taskTag, type RunState, type StateStore } from "./state.ts";
import { runTiming, taskBrief, taskNonce, taskTitle, type RunEvent } from "./workload.ts";

type Json = Record<string, any>;

export const BOARD_MIX = [
  (companyId: string) => `/api/companies/${companyId}/dashboard`,
  (companyId: string) => `/api/companies/${companyId}/issues?limit=50`,
  (companyId: string) => `/api/companies/${companyId}/agents`,
  (companyId: string) => `/api/companies/${companyId}/live-runs`,
  (companyId: string) => `/api/companies/${companyId}/sidebar-badges`,
];

const FAILED_RUN = new Set(["failed", "timed_out"]);
const RESTING_NOT_DONE = new Set(["cancelled", "blocked", "in_review"]);
const ENDED_RUN = new Set(["failed", "timed_out", "cancelled", "succeeded", "interrupted"]);
const RUN_PAGE = 1_000;
const IDS_PER_READ = 100;
const RETRY_CHECK_AFTER_MS = 60_000;
const RETRY_RECHECK_MS = 30_000;
const EVENT_FETCHES_PER_TICK = 10;
const EVENT_PAGES = 4;
const SINGLE_READS_PER_TICK = 50;
const AGENT_RUN_PAGE = 20;
const AGENT_RUN_READ_PARALLELISM = 8;

interface TaskRecord {
  id: string;
  agentId: string;
  stepIndex: number;
  nonce: string;
  createdAt: number;
  status: string;
  outcome: "open" | "done" | "failed";
  neededRetry: boolean;
  lastRetryCheckAt: number | null;
}

interface RunRecord {
  id: string;
  taskId: string;
  agentId: string;
  status: string;
  createdAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  costUsd: number;
  sampled: boolean;
  error: string | null;
  errorCode: string | null;
  liveness: string | null;
}

interface StepAccumulator {
  step: Step;
  startedAt: number;
  endedAt: number | null;
  runningSamples: number[];
  boardMs: number[];
  boardRequests: number;
  boardFailures: number;
  serverSamples: Array<Record<string, unknown>>;
  ttftMs: number[];
  firstActivityMs: number[];
  sampled: number;
}

export interface StepResult {
  index: number;
  concurrency: number;
  holdMs: number;
  metrics: StepMetrics;
  criteriaAtEnd: CriterionResult[];
  criteriaFinal: CriterionResult[];
}

export interface StopReason {
  stepIndex: number;
  reason: string;
  criterion: string | null;
}

export interface RampOutcome {
  steps: StepResult[];
  stop: StopReason | null;
  drained: boolean;
  openTasksAtEnd: number;
  tasksCreated: number;
  taskCapReached: boolean;
  recordedSpendUsd: number;
  runsListTruncated: boolean;
  metricsSource: "endpoint" | "not provided" | "unavailable";
}

export interface RampDeps {
  api: PaperclipClient;
  clock: Clock;
  fetcher: Fetcher;
  options: Options;
  state: RunState;
  store: StateStore;
  maxTasks: number;
  spendCapUsd: number;
  metricsToken: string | null;
  log: (line: string) => void;
  shouldStop: () => boolean;
}

const ms = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const num = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

function rows(body: unknown): Json[] {
  if (Array.isArray(body)) return body as Json[];
  if (body && typeof body === "object") {
    for (const key of ["issues", "rows", "items"]) {
      const value = (body as Json)[key];
      if (Array.isArray(value)) return value as Json[];
    }
  }
  return [];
}

type Sample = Record<string, unknown>;
const processOf = (sample: Sample) => typeof sample.processId === "string" ? sample.processId : "";

function counterBaseline(first: Sample, earlier: readonly Sample[], runStartedAt: number | null, counter: string): number {
  const processId = processOf(first);
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const value = num(earlier[index]![counter]);
    if (processOf(earlier[index]!) === processId && value !== null) return value;
  }
  const uptimeSec = num(first.uptimeSec);
  const sampledAt = num(first.sampledAt);
  if (runStartedAt !== null && uptimeSec !== null && sampledAt !== null && sampledAt - uptimeSec * 1_000 > runStartedAt) return 0;
  return num(first[counter]) ?? 0;
}

function counterGrowth(samples: readonly Sample[], earlier: readonly Sample[], runStartedAt: number | null, counter: string): number | null {
  const byProcess = new Map<string, Sample[]>();
  for (const sample of samples) {
    if (num(sample[counter]) === null) continue;
    const processId = processOf(sample);
    byProcess.set(processId, [...byProcess.get(processId) ?? [], sample]);
  }
  if (byProcess.size === 0) return null;
  let growth = 0;
  for (const processSamples of byProcess.values()) {
    const last = num(processSamples[processSamples.length - 1]![counter])!;
    growth += Math.max(0, last - counterBaseline(processSamples[0]!, earlier, runStartedAt, counter));
  }
  return growth;
}

export function serverMetrics(samples: ReadonlyArray<Sample>, history: { earlier?: readonly Sample[]; runStartedAt?: number | null } = {}): ServerMetrics {
  const max = (key: string) => {
    const values = samples.map(sample => num(sample[key])).filter((value): value is number => value !== null);
    return values.length ? Math.max(...values) : null;
  };
  return {
    mainThreadCpuMax: max("mainThreadCpu"),
    eventLoopUtilizationMax: max("eventLoopUtilization"),
    eventLoopDelayP99MsMax: max("eventLoopDelayP99Ms"),
    statementsPerSecondMax: max("statementsPerSecond"),
    poolWaitP99MsMax: max("poolWaitP99Ms"),
    runEventLatenessP99MsMax: max("runEventLatenessP99Ms"),
    agentApiPreHandlerP99MsMax: max("agentApiPreHandlerP99Ms"),
    leaseRenewalsMissed: counterGrowth(samples, history.earlier ?? [], history.runStartedAt ?? null, "leaseRenewalsMissed"),
    samples: samples.length,
  };
}

export class Ramp {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly runsByTask = new Map<string, Set<string>>();
  private readonly openByAgent = new Map<string, string>();
  private readonly accumulators: StepAccumulator[] = [];
  private nextBoardAt = 0;
  private nextPollAt = 0;
  private taskCapReached = false;
  private fallbackCursor = 0;
  private runsListTruncated = false;
  private metricsSource: RampOutcome["metricsSource"];
  private readonly deps: RampDeps;

  constructor(deps: RampDeps) {
    this.deps = deps;
    this.metricsSource = deps.options.metricsUrl ? "unavailable" : "not provided";
  }

  private get companyId(): string {
    return this.deps.state.companyId!;
  }

  private current(): StepAccumulator {
    return this.accumulators[this.accumulators.length - 1]!;
  }

  async run(): Promise<RampOutcome> {
    const { options, clock, log } = this.deps;
    const results: StepResult[] = [];
    let stop: StopReason | null = null;
    for (const step of options.steps) {
      if (this.deps.shouldStop()) {
        stop = { stepIndex: step.index, reason: "interrupted before the step", criterion: null };
        break;
      }
      log(`Step ${step.index + 1}/${options.steps.length}: ${step.concurrency} agents for ${Math.round(step.holdMs / 60_000)} min`);
      const accumulator: StepAccumulator = { step, startedAt: clock.now(), endedAt: null, runningSamples: [], boardMs: [], boardRequests: 0,
        boardFailures: 0, serverSamples: [], ttftMs: [], firstActivityMs: [], sampled: 0 };
      this.accumulators.push(accumulator);
      stop = await this.prepareStep(step);
      if (!stop) {
        this.nextPollAt = 0;
        this.nextBoardAt = 0;
        accumulator.startedAt = clock.now();
        stop = await this.loop(accumulator.startedAt + step.holdMs, step.concurrency);
      }
      accumulator.endedAt = clock.now();
      const atEnd = evaluate(this.metrics(step.index), options.thresholds);
      results.push({ index: step.index, concurrency: step.concurrency, holdMs: step.holdMs, metrics: this.metrics(step.index), criteriaAtEnd: atEnd, criteriaFinal: atEnd });
      if (stop) break;
      const failed = firstFailure(atEnd);
      if (failed) {
        stop = { stepIndex: step.index, reason: `${failed.id} failed at the end of the step (observed ${failed.observed}, needs ${failed.threshold})`, criterion: failed.id };
        break;
      }
      log(`Step ${step.index + 1} passed its measured criteria`);
    }
    let drained = false;
    if (!stop && options.drainMs > 0) {
      log(`Draining open tasks for up to ${Math.round(options.drainMs / 60_000)} min`);
      stop = await this.loop(clock.now() + options.drainMs, 0, true);
      drained = !stop && this.openTasks().length === 0;
      const last = this.current();
      last.endedAt = clock.now();
    }
    for (const result of results) {
      result.metrics = this.metrics(result.index);
      result.criteriaFinal = evaluate(result.metrics, options.thresholds);
    }
    return {
      steps: results, stop, drained, openTasksAtEnd: this.openTasks().length, tasksCreated: this.tasks.size, taskCapReached: this.taskCapReached,
      recordedSpendUsd: this.recordedSpend(), runsListTruncated: this.runsListTruncated, metricsSource: this.metricsSource,
    };
  }

  private async prepareStep(step: Step): Promise<StopReason | null> {
    try {
      if (step.index === 0) {
        const stop = await this.preflight();
        if (stop) return stop;
      }
      if (this.deps.shouldStop()) return { stepIndex: step.index, reason: "interrupted before the step", criterion: null };
      await ensureAgents({ api: this.deps.api, options: this.deps.options, state: this.deps.state, store: this.deps.store, count: step.concurrency });
      return await this.awaitAgents(step.concurrency, step.index);
    } catch (error) {
      if (!(error instanceof AgentsNotReady)) throw error;
      this.deps.log(`Stopping: ${error.message}`);
      return { stepIndex: step.index, reason: error.message, criterion: "agents_ready" };
    }
  }

  private async awaitAgents(count: number, stepIndex: number): Promise<StopReason | null> {
    const { api, clock, options, state, log, shouldStop } = this.deps;
    let stop: StopReason | null = null;
    await waitForAgentsReady({ api, clock, companyId: this.companyId, agentIds: state.agentIds.slice(0, count), timeoutMs: options.agentReadyTimeoutMs,
      pollMs: Math.min(options.pollMs, 5_000), shouldStop, log,
      tick: async () => {
        if (!this.tasks.size) return false;
        await this.poll(false);
        stop = this.immediateStop(stepIndex);
        return stop !== null;
      } });
    return stop;
  }

  private async preflight(): Promise<StopReason | null> {
    const { api, clock, options, state, store, log } = this.deps;
    await ensureAgents({ api, options, state, store, count: 1 });
    const notReady = await this.awaitAgents(1, 0);
    if (notReady) return notReady;
    if (this.deps.shouldStop()) return { stepIndex: 0, reason: "interrupted before the step", criterion: null };
    log(`Preflight: one task on one agent must start within ${Math.round(options.startTimeoutMs / 60_000)} min before the rest are created`);
    await this.topUp(1, 0, Number.POSITIVE_INFINITY);
    const task = [...this.tasks.values()][0];
    if (!task) return { stepIndex: 0, reason: "the preflight task was not created", criterion: "run_started" };
    for (;;) {
      if (this.deps.shouldStop()) return { stepIndex: 0, reason: "interrupted", criterion: null };
      await this.poll();
      const immediate = this.immediateStop(0);
      if (immediate) return immediate;
      if (this.anyStarted()) {
        log(`Preflight passed: the first task started ${Math.round((clock.now() - task.createdAt) / 1_000)} s after it was created`);
        this.current().runningSamples.length = 0;
        return null;
      }
      const ended = this.runsOf(task.id).find(run => run.finishedAt !== null || ENDED_RUN.has(run.status));
      if (task.outcome !== "open" || ended) {
        return this.stall(0, task, `the preflight task ended before any run started`);
      }
      const stop = await this.noStartStop(0);
      if (stop) return stop;
      await clock.sleep(options.pollMs);
    }
  }

  private anyStarted(): boolean {
    for (const run of this.runs.values()) if (run.startedAt !== null || run.status === "running") return true;
    return false;
  }

  private async noStartStop(stepIndex: number): Promise<StopReason | null> {
    const { clock, options } = this.deps;
    if (!this.tasks.size || this.anyStarted()) return null;
    const first = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)[0]!;
    if (clock.now() - first.createdAt < options.startTimeoutMs) return null;
    return this.stall(stepIndex, first, `no run started within ${Math.round(options.startTimeoutMs / 60_000)} min of the first task`);
  }

  private async stall(stepIndex: number, task: TaskRecord, headline: string): Promise<StopReason> {
    const { api, log } = this.deps;
    const [view, agents] = await Promise.all([
      api.get<Json>(`/api/issues/${task.id}`).catch(() => null),
      api.get<Json[]>(`/api/companies/${this.companyId}/agents`).catch(() => [] as Json[]),
    ]);
    const run = this.runsOf(task.id).at(-1);
    const agent = agents.find(candidate => String(candidate.id) === task.agentId);
    const runLine = run
      ? `its run ${run.id} is ${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}${run.error ? `: ${run.error.slice(0, 300)}` : ""}${run.liveness ? `; liveness: ${run.liveness}` : ""}`
      : "Paperclip lists no run for it";
    const blocker = view?.executionBlocker ? `; execution blocker: ${JSON.stringify(view.executionBlocker).slice(0, 300)}` : "";
    const reason = `${headline}. Task ${task.nonce} is ${view?.status ?? task.status}`
      + `${blocker}; ${runLine}; ${agent ? describeAgent(agent) : `agent ${task.agentId} is not listed`}`;
    log(`Stopping: ${reason}`);
    return { stepIndex, reason, criterion: "run_started" };
  }

  private async loop(until: number, concurrency: number, draining = false): Promise<StopReason | null> {
    const { clock, options } = this.deps;
    const stepIndex = this.current().step.index;
    while (clock.now() < until) {
      if (this.deps.shouldStop()) return { stepIndex, reason: "interrupted", criterion: null };
      if (clock.now() >= this.nextBoardAt) {
        this.nextBoardAt = clock.now() + options.boardProbeMs;
        await this.probeBoard();
      }
      if (clock.now() >= this.nextPollAt) {
        this.nextPollAt = clock.now() + options.pollMs;
        await this.poll();
        const stop = this.immediateStop(stepIndex) ?? await this.noStartStop(stepIndex);
        if (stop) return stop;
        if (!draining) await this.topUp(concurrency, stepIndex, until);
        else if (this.openTasks().length === 0) return null;
      }
      const wake = Math.min(this.nextBoardAt, this.nextPollAt, until);
      await clock.sleep(Math.max(1, wake - clock.now()));
    }
    return null;
  }

  private immediateStop(stepIndex: number): StopReason | null {
    if (this.recordedSpend() > this.deps.spendCapUsd) {
      return { stepIndex, reason: `recorded model spend $${this.recordedSpend().toFixed(2)} passed the cap of $${this.deps.spendCapUsd}`, criterion: "spend_cap" };
    }
    for (const accumulator of this.accumulators) {
      const failed = firstFailure(evaluate(this.metrics(accumulator.step.index), this.deps.options.thresholds, true));
      if (failed) return { stepIndex, reason: `${failed.id} failed (observed ${failed.observed}, needs ${failed.threshold})`, criterion: failed.id };
    }
    return null;
  }

  private openTasks(): TaskRecord[] {
    return [...this.tasks.values()].filter(task => task.outcome === "open");
  }

  private recordedSpend(): number {
    let total = 0;
    for (const run of this.runs.values()) total += run.costUsd;
    return Math.round(total * 100) / 100;
  }

  private async topUp(concurrency: number, stepIndex: number, until: number): Promise<void> {
    const { api, state, store, options } = this.deps;
    for (const agentId of state.agentIds.slice(0, concurrency)) {
      if (this.deps.shouldStop() || this.deps.clock.now() >= until) return;
      if (this.openByAgent.has(agentId)) continue;
      if (this.tasks.size >= this.deps.maxTasks) {
        this.taskCapReached = true;
        return;
      }
      const index = state.taskIds.length;
      const nonce = taskNonce(options.label, index);
      const created = await api.post<{ id: string }>(`/api/companies/${this.companyId}/issues`, {
        title: taskTitle(taskTag(options.label), nonce),
        description: taskBrief(nonce),
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        ...(state.projectId ? { projectId: state.projectId } : {}),
      });
      const id = String(created.id);
      state.taskIds.push(id);
      await store.save(state);
      this.tasks.set(id, { id, agentId, stepIndex, nonce, createdAt: this.deps.clock.now(), status: "todo", outcome: "open", neededRetry: false, lastRetryCheckAt: null });
      this.openByAgent.set(agentId, id);
    }
  }

  private async probeBoard(): Promise<void> {
    const accumulator = this.current();
    for (const route of BOARD_MIX) {
      const before = this.deps.api.records.length;
      await this.deps.api.get(route(this.companyId), "board").catch(() => null);
      const record = this.deps.api.records[before];
      if (!record) continue;
      accumulator.boardRequests += 1;
      if (record.ok) accumulator.boardMs.push(record.ms);
      else accumulator.boardFailures += 1;
    }
  }

  private async poll(recordSample = true): Promise<void> {
    await this.readRuns();
    await this.readTasks();
    await this.checkRetry();
    await this.sampleEvents();
    let running = 0;
    for (const run of this.runs.values()) if (run.status === "running") running += 1;
    if (!recordSample) return;
    this.current().runningSamples.push(running);
    if (this.deps.options.metricsUrl) {
      const sample = await readMetrics(this.deps.fetcher, this.deps.options.metricsUrl, this.deps.metricsToken, this.deps.clock);
      if (sample) {
        this.metricsSource = "endpoint";
        this.current().serverSamples.push(sample);
      }
    }
  }

  private noteRun(row: Json): void {
    const taskId = String(row.issueId ?? row.contextSnapshot?.issueId ?? "");
    if (!this.tasks.has(taskId)) return;
    const id = String(row.id ?? row.runId);
    const previous = this.runs.get(id);
    this.runs.set(id, {
      id, taskId, agentId: String(row.agentId), status: String(row.status), createdAt: ms(row.createdAt), startedAt: ms(row.startedAt),
      finishedAt: ms(row.finishedAt), costUsd: num(row.costUsd) ?? previous?.costUsd ?? 0, sampled: previous?.sampled ?? false,
      error: typeof row.error === "string" && row.error ? row.error : null,
      errorCode: typeof row.errorCode === "string" && row.errorCode ? row.errorCode : null,
      liveness: typeof row.livenessReason === "string" && row.livenessReason ? row.livenessReason : null,
    });
    const own = this.runsByTask.get(taskId) ?? new Set<string>();
    own.add(id);
    this.runsByTask.set(taskId, own);
  }

  private async readRuns(): Promise<void> {
    const page = await this.deps.api.get<Json[]>(`/api/companies/${this.companyId}/heartbeat-runs?summary=true&limit=${RUN_PAGE}`);
    for (const row of page) this.noteRun(row);
    if (page.length < RUN_PAGE) return;
    this.runsListTruncated = true;
    const listed = new Set(page.map(row => String(row.id)));
    const agents = new Set<string>();
    for (const run of this.runs.values()) if (LIVE_RUN_STATUSES.has(run.status) && !listed.has(run.id)) agents.add(run.agentId);
    for (const task of this.openTasks()) if (!(this.runsByTask.get(task.id)?.size)) agents.add(task.agentId);
    await mapLimit([...agents], AGENT_RUN_READ_PARALLELISM, async agentId => {
      const own = await this.deps.api.get<Json[]>(`/api/companies/${this.companyId}/heartbeat-runs?agentId=${agentId}&summary=true&limit=${AGENT_RUN_PAGE}`)
        .catch(() => [] as Json[]);
      for (const row of own) this.noteRun(row);
    });
  }

  private async readTasks(): Promise<void> {
    const open = this.openTasks();
    const missing: TaskRecord[] = [];
    for (let offset = 0; offset < open.length; offset += IDS_PER_READ) {
      const batch = open.slice(offset, offset + IDS_PER_READ);
      const body = await this.deps.api.get<unknown>(`/api/companies/${this.companyId}/issues?view=rows&ids=${batch.map(task => task.id).join(",")}`).catch(() => null);
      const byId = new Map(rows(body).map(row => [String(row.id), row]));
      for (const task of batch) {
        const row = byId.get(task.id);
        if (row?.status) this.settle(task, String(row.status));
        else missing.push(task);
      }
    }
    if (!missing.length) return;
    const start = this.fallbackCursor % missing.length;
    const chosen = [...missing.slice(start), ...missing.slice(0, start)].slice(0, SINGLE_READS_PER_TICK);
    this.fallbackCursor += chosen.length;
    for (const task of chosen) {
      const row = await this.deps.api.get<Json>(`/api/issues/${task.id}`).catch(() => null);
      if (row?.status) this.settle(task, String(row.status));
    }
  }

  private settle(task: TaskRecord, status: string): void {
    task.status = status;
    if (status === "done") task.outcome = "done";
    else if (RESTING_NOT_DONE.has(status)) task.outcome = "failed";
    if (task.outcome !== "open" && this.openByAgent.get(task.agentId) === task.id) this.openByAgent.delete(task.agentId);
  }

  private runsOf(taskId: string): RunRecord[] {
    return [...(this.runsByTask.get(taskId) ?? [])].map(id => this.runs.get(id)!).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  private async checkRetry(): Promise<void> {
    const now = this.deps.clock.now();
    for (const task of this.tasks.values()) {
      if (task.neededRetry || task.outcome === "done") continue;
      if (task.lastRetryCheckAt !== null && now - task.lastRetryCheckAt < RETRY_RECHECK_MS) continue;
      const runs = this.runsOf(task.id);
      if (!runs.length || runs.some(run => LIVE_RUN_STATUSES.has(run.status))) continue;
      const last = runs[runs.length - 1]!;
      const idle = last.finishedAt !== null && now - last.finishedAt >= RETRY_CHECK_AFTER_MS;
      if (task.outcome === "open" && last.status === "succeeded" && !idle) continue;
      if (task.outcome === "failed" && task.lastRetryCheckAt !== null) continue;
      task.lastRetryCheckAt = now;
      const view = await this.deps.api.get<Json>(`/api/issues/${task.id}`).catch(() => null);
      if (view && view.status !== "done" && view.interruption?.canRetry === true && !view.interruption?.retryWait) {
        task.neededRetry = true;
        this.deps.log(`Task ${task.nonce} offers Retry`);
      }
    }
  }

  private async sampleEvents(): Promise<void> {
    const cap = this.deps.options.eventSamplePerStep;
    let fetched = 0;
    for (const run of this.runs.values()) {
      if (fetched >= EVENT_FETCHES_PER_TICK) return;
      if (run.sampled || run.status !== "succeeded") continue;
      const accumulator = this.accumulators[this.tasks.get(run.taskId)!.stepIndex]!;
      if (accumulator.sampled >= cap) continue;
      run.sampled = true;
      accumulator.sampled += 1;
      fetched += 1;
      const events: RunEvent[] = [];
      for (let page = 0, afterSeq = 0; page < EVENT_PAGES; page += 1) {
        const rowsPage = await this.deps.api.get<Json[]>(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=500`).catch(() => [] as Json[]);
        for (const row of rowsPage) events.push({ eventType: String(row.eventType), createdAt: String(row.createdAt), payload: (row.payload ?? null) as Json | null });
        const last = Number(rowsPage.at(-1)?.seq);
        if (rowsPage.length < 500 || !Number.isFinite(last)) break;
        afterSeq = last;
      }
      const timing = runTiming(events, run.createdAt);
      if (timing.ttftMs !== null) accumulator.ttftMs.push(timing.ttftMs);
      if (timing.firstActivityMs !== null) accumulator.firstActivityMs.push(timing.firstActivityMs);
    }
  }

  metrics(stepIndex: number): StepMetrics {
    const accumulator = this.accumulators[stepIndex]!;
    const tasks = [...this.tasks.values()].filter(task => task.stepIndex === stepIndex);
    const taskIds = new Set(tasks.map(task => task.id));
    const runs = [...this.runs.values()].filter(run => taskIds.has(run.taskId));
    const firstStart = new Map<string, number>();
    for (const run of runs) {
      if (run.startedAt === null) continue;
      const known = firstStart.get(run.taskId);
      if (known === undefined || run.startedAt < known) firstStart.set(run.taskId, run.startedAt);
    }
    const samples = accumulator.runningSamples;
    let spend = 0;
    for (const run of runs) spend += run.costUsd;
    return {
      step: accumulator.step,
      startedAt: accumulator.startedAt,
      endedAt: accumulator.endedAt,
      tasksCreated: tasks.length,
      tasksStarted: firstStart.size,
      tasksFinished: tasks.filter(task => task.outcome === "done").length,
      tasksFailed: tasks.filter(task => task.outcome === "failed").length,
      tasksNeedingRetry: tasks.filter(task => task.neededRetry).length,
      runsFailed: runs.filter(run => FAILED_RUN.has(run.status)).length,
      runsInterrupted: runs.filter(run => run.status === "interrupted").length,
      runsCancelled: runs.filter(run => run.status === "cancelled").length,
      peakRunning: samples.length ? Math.max(...samples) : 0,
      meanRunning: samples.length ? Math.round((samples.reduce((sum, value) => sum + value, 0) / samples.length) * 10) / 10 : null,
      queueWaitMs: distribution(runs.flatMap(run => run.startedAt !== null && run.createdAt !== null ? [run.startedAt - run.createdAt] : [])),
      taskToStartMs: distribution(tasks.flatMap(task => firstStart.has(task.id) ? [firstStart.get(task.id)! - task.createdAt] : [])),
      ttftMs: distribution(accumulator.ttftMs),
      firstActivityMs: distribution(accumulator.firstActivityMs),
      runDurationMs: distribution(runs.flatMap(run => run.startedAt !== null && run.finishedAt !== null ? [run.finishedAt - run.startedAt] : [])),
      board: { requests: accumulator.boardRequests, failures: accumulator.boardFailures, ms: distribution(accumulator.boardMs) },
      server: serverMetrics(accumulator.serverSamples, {
        earlier: this.accumulators.slice(0, stepIndex).flatMap(earlier => earlier.serverSamples),
        runStartedAt: this.accumulators[0]?.startedAt ?? null,
      }),
      recordedSpendUsd: Math.round(spend * 100) / 100,
    };
  }
}
