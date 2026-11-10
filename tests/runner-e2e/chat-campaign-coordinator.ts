import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { campaignProductIdentityEligible, completeCampaignAttempt, reserveCampaignAttempt, type CampaignAttempt, type ChatCampaign } from "./chat-campaign.js";

type Completion = Parameters<typeof completeCampaignAttempt>[1];
export type CoordinatorStopReason = "cleanup_failure" | "secret_leak" | "shared_infrastructure" | "coordinator_failure";
export interface CampaignQualificationReview {
  evidencePath: string; receiptSha256: string;
  previous: { definitionDigest: string; graderDigest: string };
  next: { definitionDigest: string; graderDigest: string };
}
export interface ReviewedCampaignSelection { scenarioId: string; attempt: CampaignAttempt }
export interface CampaignLaunchPermit {
  reservationId: string; scenarioId: string; ordinal: 1 | 2; executionId: string;
  campaignId: string; args: readonly string[]; maxParallel: 1; automaticRetries: 0;
}
interface Entry {
  permit: CampaignLaunchPermit; reservationDigest: string; reservedAttempt: CampaignAttempt;
  phase: "reserved" | "launch_uncertain" | "completed";
  completionDigest?: string;
}
interface State {
  version: 1; selectionDigest: string; entries: Record<string, Entry>;
  stop: { reason: CoordinatorStopReason; detail: string } | null;
  failures: Array<{ scenarioId: string; phase: "reserve" | "launch" | "completion"; evidencePath: string; summary: string }>;
}
interface Pending { before: string; after: string; manifest: string; state: State }
export interface CampaignCoordinatorOptions {
  manifestPath: string; controlDirectory: string; batchId: string;
  /** Defaults to the repository root above tests/runner-e2e. */
  evidenceRoot?: string;
  selections: readonly ReviewedCampaignSelection[];
  /** Controlled filesystem fault points for offline crash tests only. */
  now?: () => string;
  fault?: (stage: "intent" | "manifest" | "state") => void;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function reviewedIdentity(selections: readonly ReviewedCampaignSelection[]) {
  return selections.map(({ scenarioId, attempt }) => ({ scenarioId, attempt: { ...attempt, startedAt: null } }));
}
function read<T>(filename: string): T { return JSON.parse(readFileSync(filename, "utf8")); }
function atomicWrite(filename: string, bytes: string) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, filename);
  const directory = openSync(path.dirname(filename), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** One ledger owner, two independent one-case launchers. Never steals a stale lock.
 * A crashed owner requires independent process/resource reconciliation before an
 * operator removes its lock. Restart never replays a launch, even if no PID was saved.
 * Reconciliation/manual ledger writers must remain paused for this owner's lifetime.
 */
export class ChatCampaignCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly plans: ReviewedCampaignSelection[];
  private readonly statePath: string;
  private readonly intentPath: string;
  private readonly lockPath: string;
  private readonly owner = randomUUID();
  private poisoned = false;
  private closed = false;
  private inFlight = 0;
  private constructor(private readonly options: CampaignCoordinatorOptions) {
    this.plans = structuredClone([...options.selections]);
    this.statePath = path.join(options.controlDirectory, "state.json");
    this.intentPath = path.join(options.controlDirectory, "pending.json");
    // Lock belongs to the manifest, not a caller-chosen batch directory.
    this.lockPath = `${options.manifestPath}.coordinator-lock`;
  }
  static open(options: CampaignCoordinatorOptions) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(options.batchId) || !options.selections.length
      || new Set(options.selections.map(x => x.scenarioId)).size !== options.selections.length)
      throw new Error("Invalid reviewed campaign selection");
    for (const { scenarioId, attempt } of options.selections) {
      if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(scenarioId) || attempt.environment !== "local"
        || attempt.automaticRetries !== 0 || attempt.outcome !== "running" || !attempt.productIdentity
        || attempt.productIdentity.kind !== "source-build" || !attempt.databaseLane)
        throw new Error("Two-lane coordinator requires reviewed local source-build provenance");
    }
    mkdirSync(options.controlDirectory, { recursive: true, mode: 0o700 });
    options = { ...options, manifestPath: realpathSync(options.manifestPath), controlDirectory: realpathSync(options.controlDirectory) };
    const coordinator = new ChatCampaignCoordinator(options);
    const fd = openSync(coordinator.lockPath, "wx", 0o600);
    try { writeFileSync(fd, json({ version: 1, owner: coordinator.owner, pid: process.pid,
      batchId: options.batchId, controlDirectory: path.resolve(options.controlDirectory), createdAt: new Date().toISOString() })); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      const selectionDigest = hash(json({ batchId: options.batchId, manifestPath: path.resolve(options.manifestPath), selections: reviewedIdentity(coordinator.plans) }));
      if (!existsSync(coordinator.statePath)) atomicWrite(coordinator.statePath, json({ version: 1, selectionDigest, entries: {}, stop: null, failures: [] } satisfies State));
      const state = read<State>(coordinator.statePath);
      if (state.version !== 1 || state.selectionDigest !== selectionDigest) throw new Error("Coordinator selection changed");
      coordinator.recover();
      return coordinator;
    } catch (error) {
      // Retain ownership on recovery failure: no second writer may guess what happened.
      coordinator.poisoned = true;
      throw error;
    }
  }
  private assertOwner() {
    if (this.closed || this.poisoned || read<{ owner: string }>(this.lockPath).owner !== this.owner)
      throw new Error("Coordinator ownership unavailable");
  }
  private serial<T>(operation: () => T): Promise<T> {
    const result = this.tail.then(() => { this.assertOwner(); return operation(); });
    this.tail = result.catch(() => undefined);
    return result;
  }
  private recover() {
    let state = read<State>(this.statePath);
    if (existsSync(this.intentPath)) {
      const pending = read<Pending>(this.intentPath), actual = hash(readFileSync(this.options.manifestPath, "utf8"));
      if (actual !== pending.before && actual !== pending.after) throw new Error("Unrecognized manifest after interrupted transaction");
      // Never replay an uncommitted reservation or completion on restart. If the
      // manifest commit landed, recover its corresponding state, then stop.
      if (actual === pending.after) state = pending.state;
      state.stop ??= { reason: "coordinator_failure", detail: "Interrupted ledger transaction; independent reconciliation required" };
      atomicWrite(this.statePath, json(state)); unlinkSync(this.intentPath);
    }
    if (Object.values(state.entries).some(x => x.phase !== "completed")) {
      state.stop ??= { reason: "coordinator_failure", detail: "Reserved or possibly launched execution; no automatic recovery launch" };
      atomicWrite(this.statePath, json(state));
    }
  }
  private commit(manifestBefore: string, manifest: ChatCampaign, state: State) {
    const bytes = json(manifest);
    try {
      atomicWrite(this.intentPath, json({ before: hash(manifestBefore), after: hash(bytes), manifest: bytes, state } satisfies Pending));
      this.options.fault?.("intent");
      if (hash(readFileSync(this.options.manifestPath, "utf8")) !== hash(manifestBefore)) throw new Error("Manifest changed outside coordinator");
      atomicWrite(this.options.manifestPath, bytes); this.options.fault?.("manifest");
      atomicWrite(this.statePath, json(state)); this.options.fault?.("state");
      unlinkSync(this.intentPath);
    } catch (error) { this.poisoned = true; throw error; }
  }
  reserve(scenarioId: string): Promise<CampaignLaunchPermit> {
    return this.serial(() => {
      const state = read<State>(this.statePath), plan = this.plans.find(x => x.scenarioId === scenarioId);
      if (!plan) throw new Error("Scenario not reviewed");
      if (state.stop) throw new Error("Admissions stopped");
      const reservationId = hash(json({ batchId: this.options.batchId, scenarioId, ordinal: plan.attempt.ordinal }));
      const reservationDigest = hash(json(reviewedIdentity([plan])));
      if (state.entries[reservationId]) {
        if (state.entries[reservationId]!.reservationDigest !== reservationDigest) throw new Error("Reservation identity conflict");
        return structuredClone(state.entries[reservationId]!.permit);
      }
      if (Object.values(state.entries).filter(x => x.phase !== "completed").length >= 2) throw new Error("Two lanes already reserved");
      const before = readFileSync(this.options.manifestPath, "utf8"), manifest = JSON.parse(before) as ChatCampaign;
      const row = manifest.scenarios.find(x => x.id === scenarioId);
      if (!row || row.executionId !== plan.attempt.executionId || row.qualifyingDefinitionDigest !== plan.attempt.definitionDigest
        || row.qualifyingGraderDigest !== plan.attempt.graderDigest
        || !campaignProductIdentityEligible(row, plan.attempt, manifest.baselineRevision)) throw new Error("Reviewed selection differs from authoritative ledger");
      const reservedAttempt = { ...structuredClone(plan.attempt), startedAt: this.options.now?.() ?? new Date().toISOString() };
      if (!Number.isFinite(Date.parse(reservedAttempt.startedAt))) throw new Error("Invalid reservation clock");
      reserveCampaignAttempt(row, reservedAttempt);
      const permit: CampaignLaunchPermit = { reservationId, scenarioId, ordinal: plan.attempt.ordinal, executionId: plan.attempt.executionId,
        campaignId: `${this.options.batchId}-${reservationId.slice(0, 20)}`, maxParallel: 1, automaticRetries: 0,
        args: ["--id", plan.attempt.executionId, "--max-parallel", "1", "--max-automatic-retries", "0"] };
      state.entries[reservationId] = { permit, reservationDigest, reservedAttempt: structuredClone(reservedAttempt), phase: "reserved" };
      this.commit(before, manifest, state);
      return structuredClone(permit);
    });
  }
  async launchOnce<T>(permit: CampaignLaunchPermit, launchOnly: (permit: CampaignLaunchPermit) => Promise<T>): Promise<T> {
    await this.serial(() => {
      const state = read<State>(this.statePath), entry = state.entries[permit.reservationId];
      if (state.stop || !entry || entry.phase !== "reserved" || json(entry.permit) !== json(permit)) throw new Error("Launch is not admissible");
      // Persist uncertainty BEFORE calling spawn. A crash in this gap consumes
      // the permit; it can never be replayed based on absent PID alone.
      entry.phase = "launch_uncertain"; atomicWrite(this.statePath, json(state)); this.inFlight++;
    });
    try { return await launchOnly(structuredClone(permit)); }
    finally { this.inFlight--; }
  }
  complete(permit: CampaignLaunchPermit, completion: Completion, stop?: { reason: CoordinatorStopReason; detail: string }, qualificationReview?: CampaignQualificationReview): Promise<void> {
    return this.serial(() => {
      const state = read<State>(this.statePath), entry = state.entries[permit.reservationId];
      if (!entry || json(entry.permit) !== json(permit)) throw new Error("Completion identity conflict");
      const completionDigest = hash(json({ completion, stop: stop ?? null, qualificationReview: qualificationReview ?? null }));
      if (entry.phase === "completed") {
        if (entry.completionDigest !== completionDigest) throw new Error("Completion content conflict");
        const current = read<ChatCampaign>(this.options.manifestPath).scenarios.find(x => x.id === permit.scenarioId)?.attempts.at(-1);
        if (!current || current.ordinal !== permit.ordinal || current.executionId !== permit.executionId
          || Object.entries(completion).some(([key, value]) => json(current[key as keyof CampaignAttempt]) !== json(value)))
          throw new Error("Completed ledger differs from receipt");
        return;
      }
      if (entry.phase !== "launch_uncertain") throw new Error("No admitted launcher for completion");
      const before = readFileSync(this.options.manifestPath, "utf8"), manifest = JSON.parse(before) as ChatCampaign;
      const row = manifest.scenarios.find(x => x.id === permit.scenarioId), plan = this.plans.find(x => x.scenarioId === permit.scenarioId)!;
      const actual = row?.attempts.at(-1);
      if (!row || !actual || actual.ordinal !== permit.ordinal || json(actual) !== json(entry.reservedAttempt)) throw new Error("Reserved attempt changed");
      completeCampaignAttempt(row, structuredClone(completion));
      if (qualificationReview) {
        const review = qualificationReview;
        if (completion.outcome !== "passed" || !completion.evidencePaths.includes(review.evidencePath)
          || !review.evidencePath.startsWith("tests/runner-e2e/results/") || review.evidencePath.split("/").includes("..")
          || review.previous.definitionDigest !== plan.attempt.definitionDigest || review.previous.graderDigest !== plan.attempt.graderDigest
          || json(review.previous) === json(review.next) || !review.next.definitionDigest || !review.next.graderDigest)
          throw new Error("Invalid qualifying identity review");
        const bytes = readFileSync(path.join(this.options.evidenceRoot ?? path.resolve(path.dirname(this.options.manifestPath), "../.."), review.evidencePath), "utf8");
        const retained = JSON.parse(bytes);
        if (hash(bytes) !== review.receiptSha256 || retained.id !== permit.scenarioId || retained.ordinal !== permit.ordinal
          || json(retained.previous) !== json(review.previous) || json(retained.next) !== json(review.next))
          throw new Error("Qualifying identity review receipt mismatch");
        row.qualifyingDefinitionDigest = null; row.qualifyingGraderDigest = null;
      }
      state.stop ??= stop ?? (completion.cleanup !== "passed" ? { reason: "cleanup_failure", detail: "Measured cleanup did not pass" } : null);
      // Stop is durable before the completion/summary commit or any lane refill.
      if (state.stop) atomicWrite(this.statePath, json(state));
      entry.phase = "completed"; entry.completionDigest = completionDigest;
      this.commit(before, manifest, state);
    });
  }
  stop(reason: CoordinatorStopReason, detail: string): Promise<void> {
    return this.serial(() => { const state = read<State>(this.statePath); state.stop ??= { reason, detail }; atomicWrite(this.statePath, json(state)); });
  }
  snapshot(): Promise<Readonly<State>> { return this.serial(() => read<State>(this.statePath)); }
  /** Finite waves avoid refilling while an already settled peer awaits grading.
   * readCompletion owns authentic result/usage and normalized selected-closure
   * fingerprint validation (not unrelated raw descriptor/manifest bytes). It must
   * distinguish actual secret matches from safe, bound-only ZIP omissions.
   */
  async run<T>(input: {
    launchOnly: (permit: CampaignLaunchPermit) => Promise<T>;
    /** Parent redacts and retains the real failure privately before returning a safe reference. */
    retainFailure: (permit: CampaignLaunchPermit | null, error: unknown, phase: "reserve" | "launch" | "completion") => Promise<{ evidencePath: string; summary: string }>;
    readCompletion: (permit: CampaignLaunchPermit, result: T) => Promise<{ completion: Completion; stop?: { reason: CoordinatorStopReason; detail: string }; qualificationReview?: CampaignQualificationReview }>;
  }) {
    const unretained: unknown[] = [];
    const existing = await this.snapshot();
    const remaining = this.plans.filter(plan => !Object.values(existing.entries).some(entry => entry.permit.scenarioId === plan.scenarioId && entry.phase === "completed"));
    for (let index = 0; index < remaining.length; index += 2) {
      if ((await this.snapshot()).stop) break;
      const settled = await Promise.allSettled(remaining.slice(index, index + 2).map(async plan => {
        let permit: CampaignLaunchPermit | null = null;
        let phase: "reserve" | "launch" | "completion" = "reserve";
        try {
          permit = await this.reserve(plan.scenarioId); phase = "launch";
          const result = await this.launchOnce(permit, input.launchOnly); phase = "completion";
          const observed = await input.readCompletion(permit, result);
          await this.complete(permit, observed.completion, observed.stop, observed.qualificationReview);
        } catch (error) {
          try {
            const retained = await input.retainFailure(permit, error, phase);
            if (!retained.evidencePath.startsWith("tests/runner-e2e/results/") || retained.evidencePath.split("/").includes("..") || !retained.summary.trim())
              throw new Error("Failure requires a sanitized retained evidence reference");
            if (!this.poisoned) await this.serial(() => {
              const state = read<State>(this.statePath);
              state.failures.push({ scenarioId: plan.scenarioId, phase, ...retained });
              state.stop ??= { reason: "coordinator_failure", detail: `${retained.summary} (${retained.evidencePath})` };
              atomicWrite(this.statePath, json(state));
            });
            else unretained.push(error); // WAL/lock remain authoritative; expose original error to owner.
          } catch (retentionError) {
            unretained.push(error, retentionError);
            if (!this.poisoned) await this.stop("coordinator_failure", "Failure evidence retention failed; inspect returned errors");
          }
        }
      }));
      for (const result of settled) if (result.status === "rejected") unretained.push(result.reason);
      if (unretained.length) throw new AggregateError(unretained, "Coordinator failure requires independent reconciliation; no further admission");
      if (this.poisoned) throw new Error("Coordinator ledger transaction interrupted");
      if ((await this.snapshot()).stop) break;
    }
    return this.snapshot();
  }
  close(): Promise<void> {
    return this.serial(() => {
      if (this.inFlight) throw new Error("Cannot release coordinator with launchers in flight");
      if (existsSync(this.intentPath)) throw new Error("Cannot release interrupted transaction");
      unlinkSync(this.lockPath); this.closed = true;
    });
  }
}
