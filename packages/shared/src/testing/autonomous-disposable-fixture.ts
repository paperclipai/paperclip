import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTONOMOUS_MERGE_GATE_IDS,
  autonomousMergeRequestSchema,
  createAutonomousMergeGateEvidence,
  decideControlledAutonomousMerge,
  type AutonomousMergeRequest,
  type AutonomousMergeDecision,
} from "../autonomous-merge-gate.js";
import {
  autonomousActionRequestSchema,
  autonomousEffectRecordSchema,
  createAutonomousEffectRecord,
  decideAutonomousActionDedup,
  type AutonomousActionRequest,
  type AutonomousActionDedupDecision,
  type AutonomousEffectRecord,
} from "../autonomous-idempotency-contract.js";
import { decideAutonomousRisk } from "../autonomous-risk-policy.js";
import {
  autonomousRetryDecisionSchema,
  decideAutonomousRetry,
  type AutonomousRetryDecision,
} from "../autonomous-retry-policy.js";
import {
  autonomousGateEvidenceSchema,
  autonomousStateEnvelopeSchema,
  evaluateAutonomousGate,
  transitionAutonomousState,
  type AutonomousGateDecision,
  type AutonomousGateEvidence,
  type AutonomousStateEnvelope,
} from "../autonomous-state-contract.js";

export type DisposableScope = {
  tenantId: string;
  projectId: string;
  boardId: string;
};

type DisposableTask = {
  taskId: string;
  parentTaskId: string | null;
  scope: DisposableScope;
  envelope: AutonomousStateEnvelope;
};

type DisposableWorker = {
  workerId: string;
  taskId: string;
  scope: DisposableScope;
};

export type DisposableSessionCheckpoint = {
  runId: string;
  taskId: string;
  issueId: string;
  sessionId: string;
  sessionKey: string;
  timeoutSec: number;
};

export type DisposableCrashPoint = "none" | "after-state-write-before-effect" | "after-effect-before-ack";

export type DisposableRecoveryResult = {
  wakeup: ActionResult;
  worker: WorkerResult;
  recoveryEvent: "EMITTED" | "EXISTING";
};

type RuntimeSnapshot = {
  tasks: Array<Pick<DisposableTask, "taskId" | "parentTaskId" | "scope">>;
  workers: DisposableWorker[];
  effects: AutonomousEffectRecord[];
  wakeupEffectKeys: string[];
  retryActionIds: string[];
  recoveryEventKeys?: string[];
  pendingActionIds?: string[];
  sessionCheckpoints?: DisposableSessionCheckpoint[];
};

type ClaimResult =
  | { outcome: "CLAIMED"; taskId: string; workerId: string }
  | { outcome: "DENY"; reason: "DEPENDENCY_NOT_PASS" | "TASK_NOT_READY" | "TASK_ALREADY_CLAIMED" };
type MutationResult =
  | { outcome: "ALLOW" }
  | { outcome: "DENY"; reason: "SCOPE_DENIED_TASK" | "SCOPE_DENIED_BOARD" | "SCOPE_DENIED_TENANT" | "SCOPE_DENIED_PROJECT" };
type WorkerResult = { outcome: "REGISTERED" | "EXISTING" };
type ActionResult = AutonomousActionDedupDecision;

type ActionRequestInput = Pick<
  AutonomousActionRequest,
  "actionId" | "idempotencyKey" | "executionId" | "taskId" | "kind" | "effectType" | "effectPayload"
> &
  Partial<Pick<AutonomousActionRequest, "parentExecutionId" | "workerId" | "attempt">>;

type TaskInput = {
  taskId: string;
  parentTaskId?: string | null;
  scope: DisposableScope;
};

type MergeInput = {
  workerId: string;
  taskId: string;
  scopeId: string;
  failedGate?: (typeof AUTONOMOUS_MERGE_GATE_IDS)[number];
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function envelopeFile(root: string, taskId: string): string {
  return join(root, `envelope-${encodeURIComponent(taskId)}.json`);
}

function runtimeFile(root: string): string {
  return join(root, "runtime.json");
}

export class DisposableAutonomousFixture {
  private readonly root: string;
  private readonly tasks = new Map<string, DisposableTask>();
  private readonly workers = new Map<string, DisposableWorker>();
  private effects: AutonomousEffectRecord[] = [];
  private wakeupEffectKeys = new Set<string>();
  private retryActionIds = new Set<string>();
  private recoveryEventKeys = new Set<string>();
  private pendingActionIds = new Set<string>();
  private sessionCheckpoints = new Map<string, DisposableSessionCheckpoint>();
  private clockMs = Date.parse("2026-09-27T00:00:00.000Z");
  private disposed = false;

  constructor(root: string, rehydrate = false) {
    this.root = root;
    if (rehydrate) this.rehydrate();
    else this.persistRuntime();
  }

  addTask(input: TaskInput): void {
    if (this.tasks.has(input.taskId)) throw new Error(`Duplicate fixture task: ${input.taskId}`);
    const createdAt = this.timestamp();
    const parentTaskId = input.parentTaskId ?? null;
    const parent = parentTaskId ? this.tasks.get(parentTaskId) : undefined;
    const envelope = autonomousStateEnvelopeSchema.parse({
      schemaVersion: 1,
      executionId: `execution-${input.taskId}`,
      taskId: input.taskId,
      parentExecutionId: parent?.envelope.executionId ?? null,
      risk: "LOW",
      state: "PENDING",
      dependencies: parent
        ? [{ dependencyId: parentTaskId, state: parent.envelope.state === "PASS" ? "PASS" : "PENDING" }]
        : [],
      workers: [],
      gates: [],
      attempt: 1,
      createdAt,
      updatedAt: createdAt,
    });
    this.tasks.set(input.taskId, { taskId: input.taskId, parentTaskId, scope: clone(input.scope), envelope });
    this.persistEnvelope(envelope);
    this.persistRuntime();
  }

  isReady(taskId: string): boolean {
    const task = this.task(taskId);
    if (task.envelope.state !== "PENDING") return false;
    if (task.parentTaskId && this.task(task.parentTaskId).envelope.state !== "PASS") return false;
    return ![...this.workers.values()].some((worker) => worker.taskId === taskId);
  }

  claim(taskId: string, workerId: string): ClaimResult {
    const task = this.task(taskId);
    if (task.envelope.state !== "PENDING") return { outcome: "DENY", reason: "TASK_ALREADY_CLAIMED" };
    if (task.parentTaskId) {
      const parent = this.task(task.parentTaskId);
      if (parent.envelope.state !== "PASS") return { outcome: "DENY", reason: "DEPENDENCY_NOT_PASS" };
    }
    if (!this.isReady(taskId)) return { outcome: "DENY", reason: "TASK_NOT_READY" };
    if ([...this.workers.values()].some((worker) => worker.taskId === taskId)) {
      return { outcome: "DENY", reason: "TASK_ALREADY_CLAIMED" };
    }

    this.registerWorker({ workerId, taskId, scope: task.scope });
    let envelope = transitionAutonomousState(task.envelope, "PLANNING", this.timestamp());
    envelope = transitionAutonomousState(envelope, "RUNNING", this.timestamp());
    envelope = autonomousStateEnvelopeSchema.parse({
      ...envelope,
      workers: [{ workerId, role: "worker", state: "RUNNING" }],
    });
    task.envelope = envelope;
    this.persistEnvelope(envelope);
    this.persistRuntime();
    return { outcome: "CLAIMED", taskId, workerId };
  }

  complete(taskId: string): void {
    const task = this.task(taskId);
    let envelope = transitionAutonomousState(task.envelope, "VERIFYING", this.timestamp());
    envelope = transitionAutonomousState(envelope, "PASS", this.timestamp());
    envelope = autonomousStateEnvelopeSchema.parse({
      ...envelope,
      workers: envelope.workers.map((worker) => ({ ...worker, state: "PASS" as const })),
    });
    task.envelope = envelope;
    this.persistEnvelope(envelope);
    this.persistRuntime();
  }

  fail(taskId: string): void {
    const task = this.task(taskId);
    const envelope = transitionAutonomousState(task.envelope, "FAILED", this.timestamp());
    task.envelope = autonomousStateEnvelopeSchema.parse({
      ...envelope,
      workers: envelope.workers.map((worker) => ({ ...worker, state: "FAILED" as const })),
    });
    this.persistEnvelope(task.envelope);
    this.persistRuntime();
  }

  registerWorker(input: DisposableWorker): WorkerResult {
    const existing = this.workers.get(input.workerId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input)) {
        throw new Error(`Worker identity conflict: ${input.workerId}`);
      }
      return { outcome: "EXISTING" };
    }
    this.workers.set(input.workerId, clone(input));
    this.persistRuntime();
    return { outcome: "REGISTERED" };
  }

  ensureWorker(input: DisposableWorker): WorkerResult {
    return this.registerWorker(input);
  }

  mutateTask(
    workerId: string,
    request: { taskId: string } & DisposableScope,
  ): MutationResult {
    const worker = this.workers.get(workerId);
    if (!worker || worker.taskId !== request.taskId) return { outcome: "DENY", reason: "SCOPE_DENIED_TASK" };
    if (worker.scope.boardId !== request.boardId) return { outcome: "DENY", reason: "SCOPE_DENIED_BOARD" };
    if (worker.scope.tenantId !== request.tenantId) return { outcome: "DENY", reason: "SCOPE_DENIED_TENANT" };
    if (worker.scope.projectId !== request.projectId) return { outcome: "DENY", reason: "SCOPE_DENIED_PROJECT" };
    return { outcome: "ALLOW" };
  }

  evaluateGate(taskId: string, input: AutonomousGateEvidence): AutonomousGateDecision {
    const evidence = autonomousGateEvidenceSchema.parse(input);
    const decision = evaluateAutonomousGate(evidence);
    const task = this.task(taskId);
    const gates = [...task.envelope.gates];
    const gateIndex = gates.findIndex((gate) => gate.gateId === evidence.gateId);
    const gateSummary = { gateId: evidence.gateId, decision };
    if (gateIndex >= 0) gates[gateIndex] = gateSummary;
    else gates.push(gateSummary);
    task.envelope = autonomousStateEnvelopeSchema.parse({
      ...task.envelope,
      gates,
      updatedAt: this.timestamp(),
    });
    this.persistEnvelope(task.envelope);
    this.persistRuntime();
    return decision;
  }

  injectTransientFailure(taskId: string, canReplan: boolean): AutonomousRetryDecision {
    const task = this.task(taskId);
    let envelope = task.envelope;
    if (envelope.state === "RETRYING") envelope = transitionAutonomousState(envelope, "RUNNING", this.timestamp());
    envelope = transitionAutonomousState(envelope, "FAILED", this.timestamp());
    const decision = autonomousRetryDecisionSchema.parse(decideAutonomousRetry({
      executionId: envelope.executionId,
      taskId: envelope.taskId,
      attempt: envelope.attempt,
      failureKind: "TRANSIENT",
      canReplan,
      priorActionIds: [...this.retryActionIds],
    }));
    this.retryActionIds.add(decision.actionId);
    envelope = transitionAutonomousState(envelope, decision.disposition, this.timestamp());
    task.envelope = autonomousStateEnvelopeSchema.parse({
      ...envelope,
      attempt: decision.disposition === "RETRYING" ? envelope.attempt + 1 : envelope.attempt,
    });
    this.persistEnvelope(task.envelope);
    this.persistRuntime();
    return decision;
  }

  actionRequest(input: ActionRequestInput): AutonomousActionRequest {
    return autonomousActionRequestSchema.parse({
      parentExecutionId: null,
      workerId: null,
      attempt: 1,
      ...input,
    });
  }

  applyAction(request: AutonomousActionRequest): ActionResult {
    const parsed = autonomousActionRequestSchema.parse(request);
    const riskDecision = decideAutonomousRisk({
      actionId: parsed.actionId,
      executionId: parsed.executionId,
      taskId: parsed.taskId,
      risk: "LOW",
      approval: "NOT_REQUIRED",
      checkpoint: null,
      backup: null,
      rollback: null,
    });
    if (riskDecision.outcome !== "ALLOW") throw new Error(`Fixture action risk denied: ${riskDecision.reasonCode}`);

    const decision = decideAutonomousActionDedup(parsed, this.effects);
    if (decision.outcome === "ACCEPT") {
      this.effects.push(createAutonomousEffectRecord(parsed));
      if (parsed.kind === "WAKEUP") this.wakeupEffectKeys.add(decision.effectKey);
      this.persistRuntime();
    }
    return decision;
  }

  executeWithCrash(request: AutonomousActionRequest, crashPoint: DisposableCrashPoint): ActionResult {
    const parsed = autonomousActionRequestSchema.parse(request);
    this.pendingActionIds.add(parsed.actionId);
    this.persistRuntime();
    if (crashPoint === "after-state-write-before-effect") {
      throw new Error("fixture_crash_after_state_write");
    }
    const decision = this.applyAction(parsed);
    if (crashPoint === "after-effect-before-ack") {
      throw new Error("fixture_crash_after_effect_before_ack");
    }
    this.pendingActionIds.delete(parsed.actionId);
    this.persistRuntime();
    return decision;
  }

  recoverWorker(input: {
    taskId: string;
    workerId: string;
    scope: DisposableScope;
    wakeup: AutonomousActionRequest;
  }): DisposableRecoveryResult {
    const wakeup = this.applyAction(input.wakeup);
    const alreadyEmitted = this.recoveryEventKeys.has(wakeup.effectKey);
    this.recoveryEventKeys.add(wakeup.effectKey);
    const worker = this.ensureWorker({ workerId: input.workerId, taskId: input.taskId, scope: input.scope });
    this.persistRuntime();
    return {
      wakeup,
      worker,
      recoveryEvent: alreadyEmitted ? "EXISTING" : "EMITTED",
    };
  }

  persistSessionCheckpoint(input: DisposableSessionCheckpoint): void {
    if (!Number.isFinite(input.timeoutSec) || input.timeoutSec < 0) {
      throw new Error("Invalid fixture session timeout");
    }
    this.sessionCheckpoints.set(input.runId, clone(input));
    this.persistRuntime();
  }

  getSessionCheckpoint(runId: string): DisposableSessionCheckpoint {
    const checkpoint = this.sessionCheckpoints.get(runId);
    if (!checkpoint) throw new Error(`Unknown fixture session: ${runId}`);
    return clone(checkpoint);
  }

  persistedRuntimeText(): string {
    return readFileSync(runtimeFile(this.root), "utf8");
  }

  graphSnapshot(): {
    tasks: Array<{ taskId: string; parentTaskId: string | null; scope: DisposableScope; envelope: AutonomousStateEnvelope }>;
    workers: DisposableWorker[];
  } {
    return clone({
      tasks: [...this.tasks.values()].map(({ taskId, parentTaskId, scope, envelope }) => ({
        taskId,
        parentTaskId,
        scope,
        envelope,
      })),
      workers: [...this.workers.values()],
    });
  }

  workerScope(workerId: string): DisposableScope {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`Unknown fixture worker: ${workerId}`);
    return clone(worker.scope);
  }

  mergeRequest(input: MergeInput): AutonomousMergeRequest {
    return autonomousMergeRequestSchema.parse({
      workerId: input.workerId,
      taskId: input.taskId,
      scopeId: input.scopeId,
      gates: AUTONOMOUS_MERGE_GATE_IDS.map((gateId) => createAutonomousMergeGateEvidence({
        gateId,
        decision: gateId === input.failedGate ? "FAIL" : "PASS",
        evidenceRef: `artifact://${input.scopeId}/${gateId}`,
        metadata: {
          summary: "fixture evidence",
          exitCode: gateId === input.failedGate ? 1 : 0,
          changedFiles: 0,
        },
      })),
    });
  }

  decideMerge(request: AutonomousMergeRequest): AutonomousMergeDecision {
    return decideControlledAutonomousMerge(request);
  }

  getEnvelope(taskId: string): AutonomousStateEnvelope {
    return clone(this.task(taskId).envelope);
  }

  effectCount(): number {
    return this.effects.length;
  }

  persistedEffectCount(): number {
    const snapshot = JSON.parse(readFileSync(runtimeFile(this.root), "utf8")) as RuntimeSnapshot;
    return snapshot.effects.length;
  }

  workerCount(): number {
    return this.workers.size;
  }

  wakeupCount(): number {
    return this.wakeupEffectKeys.size;
  }

  recoveryEventCount(): number {
    return this.recoveryEventKeys.size;
  }

  async restartLike(): Promise<DisposableAutonomousFixture> {
    return new DisposableAutonomousFixture(this.root, true);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    rmSync(this.root, { recursive: true, force: true });
  }

  private timestamp(): string {
    this.clockMs += 1_000;
    return new Date(this.clockMs).toISOString();
  }

  private task(taskId: string): DisposableTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown fixture task: ${taskId}`);
    return task;
  }

  private persistEnvelope(envelope: AutonomousStateEnvelope): void {
    writeFileSync(envelopeFile(this.root, envelope.taskId), JSON.stringify(envelope));
  }

  private persistRuntime(): void {
    const snapshot: RuntimeSnapshot = {
      tasks: [...this.tasks.values()].map(({ taskId, parentTaskId, scope }) => ({ taskId, parentTaskId, scope })),
      workers: [...this.workers.values()],
      effects: this.effects,
      wakeupEffectKeys: [...this.wakeupEffectKeys],
      retryActionIds: [...this.retryActionIds],
      recoveryEventKeys: [...this.recoveryEventKeys],
      pendingActionIds: [...this.pendingActionIds],
      sessionCheckpoints: [...this.sessionCheckpoints.values()],
    };
    writeFileSync(runtimeFile(this.root), JSON.stringify(snapshot));
  }

  private rehydrate(): void {
    const runtime = JSON.parse(readFileSync(runtimeFile(this.root), "utf8")) as RuntimeSnapshot;
    this.effects = runtime.effects.map((effect) => autonomousEffectRecordSchema.parse(effect));
    this.wakeupEffectKeys = new Set(runtime.wakeupEffectKeys);
    this.retryActionIds = new Set(runtime.retryActionIds);
    this.recoveryEventKeys = new Set(runtime.recoveryEventKeys ?? []);
    this.pendingActionIds = new Set(runtime.pendingActionIds ?? []);
    for (const checkpoint of runtime.sessionCheckpoints ?? []) {
      this.sessionCheckpoints.set(checkpoint.runId, clone(checkpoint));
    }
    for (const worker of runtime.workers) this.workers.set(worker.workerId, clone(worker));
    for (const task of runtime.tasks) {
      const envelope = autonomousStateEnvelopeSchema.parse(
        JSON.parse(readFileSync(envelopeFile(this.root, task.taskId), "utf8")),
      );
      this.tasks.set(task.taskId, { ...clone(task), envelope });
      this.clockMs = Math.max(this.clockMs, Date.parse(envelope.updatedAt));
    }
    for (const path of readdirSync(this.root)) {
      if (!path.startsWith("envelope-") || !path.endsWith(".json")) continue;
      autonomousStateEnvelopeSchema.parse(JSON.parse(readFileSync(join(this.root, path), "utf8")));
    }
  }
}

export async function createDisposableAutonomousFixture(): Promise<DisposableAutonomousFixture> {
  const root = mkdtempSync(join(tmpdir(), `paperclip-d10-${randomUUID()}-`));
  const fixture = new DisposableAutonomousFixture(root);
  return fixture;
}
