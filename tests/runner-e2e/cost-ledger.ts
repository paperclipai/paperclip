import { validateReservationBound, type EvalReservationBound } from "./cost-bound-evidence.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { usdToUnits } from "../../packages/shared/src/money.js";
import { operatingReservationBound, validateOperatingOverhead, type EvalOperatingOverhead } from "./operating-overhead.js";

export interface EvalSpendLimits {
  campaignId: string;
  maxUsd: string;
  deadlineAt: string;
  maxRequests: number;
  maxConcurrent: number;
  maxAttemptsPerExecution?: number;
  overhead?: EvalOperatingOverhead;
}
export interface EvalChargeIdentity {
  executionId: string;
  attemptId: string;
  phase: "setup" | "agent" | "judge" | "feedback_review" | "tool" | "infrastructure";
  runId?: string;
}
export interface EvalLegacyAttemptAudit {
  previousJournalHash: string;
  evidenceSha256: string;
  maxAttemptsPerExecution: number;
  priorAttempts: Array<{ executionId: string; attemptId: string }>;
}
export interface EvalCostObservation {
  observationId: string;
  requestId: string;
  source: "provider" | "gateway" | "native_otlp" | "heartbeat" | "infrastructure" | "invoice";
  provider: string;
  model?: string;
  providerRequestId?: string;
  currency: "USD";
  route: "direct" | "braintrust" | "other_gateway" | "subscription" | "infrastructure";
  classification: "reported" | "estimated" | "allocated" | "reconciled" | "unknown";
  costUsd?: string;
  pricingVersion?: string;
  tokens?: { input?: number; cachedRead?: number; cachedWrite?: number; output?: number; reasoning?: number };
  final: boolean;
}

type Event =
  | { type: "campaign"; limits: EvalSpendLimits }
  | ({ type: "attempt_policy" } & EvalLegacyAttemptAudit)
  | { type: "attempt"; executionId: string; attemptId: string }
  | { type: "reserve"; requestId: string; identity: EvalChargeIdentity; maxUsd: string; bound?: EvalReservationBound }
  | { type: "invalidate_bound"; requestId: string }
  | { type: "observe"; observation: EvalCostObservation }
  | { type: "finish"; requestId: string; outcome: "succeeded" | "failed" | "cancelled" };
interface Line { seq: number; at: string; previous: string; event: Event; hash: string }
interface RequestState { identity: EvalChargeIdentity; reserved: bigint; observations: EvalCostObservation[]; finished: boolean; bound?: EvalReservationBound; boundInvalidated?: boolean }
const usd = (units: bigint) => `${units / 1_000_000_000n}.${String(units % 1_000_000_000n).padStart(9, "0")}`;
export const validEvalLedgerId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,511}$/.test(value);
const validId = validEvalLedgerId;
const amount = (value: string) => {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value)) throw new Error("Invalid ledger USD amount");
  return usdToUnits(value);
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest("hex");
const fields = (value: object, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unknown ledger field; refusing unreviewed data");
};
const ranks = { unknown: 0, allocated: 1, estimated: 2, reported: 3, reconciled: 4 };

export class EvalAdmissionError extends Error {}

export class EvalSpendState {
  readonly limits: EvalSpendLimits;
  readonly requests = new Map<string, RequestState>();
  readonly observations = new Map<string, EvalCostObservation>();
  readonly attempts = new Map<string, string>();
  private providerRequests = new Map<string, string>();
  constructor(limits: EvalSpendLimits) {
    this.limits = structuredClone(limits);
    fields(limits, ["campaignId", "maxUsd", "deadlineAt", "maxRequests", "maxConcurrent", "maxAttemptsPerExecution", "overhead"]);
    if (!validId(limits.campaignId) || amount(limits.maxUsd) <= 0n || !Number.isFinite(Date.parse(limits.deadlineAt))
        || !Number.isSafeInteger(limits.maxRequests) || limits.maxRequests < 1
        || !Number.isSafeInteger(limits.maxConcurrent) || limits.maxConcurrent < 1
        || limits.maxAttemptsPerExecution !== undefined && (!Number.isSafeInteger(limits.maxAttemptsPerExecution) || limits.maxAttemptsPerExecution < 1)) throw new Error("Invalid eval spend limits");
    if (this.limits.overhead !== undefined) {
      validateOperatingOverhead(this.limits.overhead, this.limits.maxUsd);
      if (this.limits.maxAttemptsPerExecution === undefined || this.limits.maxRequests <= this.limits.overhead.components.length) {
        throw new Error("Operating overhead requires bounded attempts and room for model requests");
      }
      for (const component of this.limits.overhead.components) this.requests.set(`overhead:${component.component}`, {
        identity: { executionId: "campaign-overhead", attemptId: component.component, phase: "infrastructure" },
        reserved: amount(component.maxUsd), observations: [], finished: true,
        ...(component.provisionalBound ? { bound: operatingReservationBound(this.limits.overhead, component) } : {}),
      });
    }
  }
  private authoritative(request: RequestState) {
    const priced = request.observations.filter(value => value.costUsd !== undefined);
    const bestRank = Math.max(-1, ...priced.map(value => ranks[value.classification]));
    const strongest = priced.filter(value => ranks[value.classification] === bestRank);
    const finalized = strongest.filter(value => value.final);
    const best = finalized.length ? finalized : strongest;
    if (!best.length) return { cost: null, classification: "unknown" as const, conflict: false, resolved: false };
    const amounts = new Set(best.map(value => amount(value.costUsd!).toString()));
    const cost = best.reduce((maximum, value) => amount(value.costUsd!) > maximum ? amount(value.costUsd!) : maximum, 0n);
    return { cost, classification: best[0]!.classification, conflict: finalized.length > 0 && amounts.size !== 1,
      resolved: finalized.length > 0 && amounts.size === 1 };
  }
  snapshot() {
    let known = 0n, held = 0n, committed = 0n, inflight = 0, unknown = 0, conflicts = 0, boundedUnresolved = 0;
    const breakdown: Record<"reported" | "estimated" | "allocated" | "reconciled", bigint> = { reported: 0n, estimated: 0n, allocated: 0n, reconciled: 0n };
    const requests = [...this.requests].map(([requestId, request]) => {
      const receipt = this.authoritative(request);
      if (!request.finished) inflight++;
      if (receipt.conflict) conflicts++;
      if (!receipt.resolved) unknown++;
      const cost = receipt.cost ?? 0n;
      const pendingBounded = !receipt.resolved && !receipt.conflict && request.finished && !!request.bound
        && !request.boundInvalidated && cost <= request.reserved;
      if (pendingBounded) boundedUnresolved++;
      known += cost;
      if (receipt.classification !== "unknown") breakdown[receipt.classification] += cost;
      const commitment = !request.finished || !receipt.resolved
        ? (request.reserved > cost ? request.reserved : cost) : cost;
      committed += commitment;
      held += commitment - cost;
      return { requestId, ...request.identity, reservedUsd: usd(request.reserved), costUsd: receipt.cost === null ? null : usd(cost),
        classification: receipt.classification, conflict: receipt.conflict, receiptComplete: receipt.resolved, finished: request.finished, pendingBounded };
    });
    return { campaignId: this.limits.campaignId, limitUsd: usd(amount(this.limits.maxUsd)), knownUsd: usd(known), heldUsd: usd(held), committedUsd: usd(committed),
      overBudget: committed > amount(this.limits.maxUsd), unknownRequests: unknown, boundedUnresolvedRequests: boundedUnresolved, conflictingRequests: conflicts, inflight,
      breakdown: Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, usd(value)])), requests,
      admittedAttempts: [...this.attempts].map(([attemptId, executionId]) => ({ executionId, attemptId })) };
  }
  validate(event: Event, now = Date.now()) {
    if ((event.type === "attempt" || event.type === "reserve") && this.limits.overhead
        && (now < Date.parse(this.limits.overhead.verifiedAt) || now >= Date.parse(this.limits.overhead.expiresAt))) {
      throw new EvalAdmissionError("Operating overhead allowance needs review before paid admission");
    }
    if (event.type === "campaign") throw new Error("Duplicate campaign event");
    if (event.type === "attempt_policy") {
      fields(event, ["type", "previousJournalHash", "evidenceSha256", "maxAttemptsPerExecution", "priorAttempts"]);
      if (this.limits.maxAttemptsPerExecution !== undefined || this.attempts.size) throw new Error("Eval attempt policy already established");
      if (!/^[0-9a-f]{64}$/.test(event.previousJournalHash) || !/^[0-9a-f]{64}$/.test(event.evidenceSha256)
          || !Number.isSafeInteger(event.maxAttemptsPerExecution) || event.maxAttemptsPerExecution < 1
          || !Array.isArray(event.priorAttempts)) throw new Error("Invalid legacy attempt audit");
      const audited = new Map<string, string>();
      for (const attempt of event.priorAttempts) {
        fields(attempt, ["executionId", "attemptId"]);
        if (!validId(attempt.executionId) || !validId(attempt.attemptId) || audited.has(attempt.attemptId)) throw new Error("Invalid legacy attempt identity");
        audited.set(attempt.attemptId, attempt.executionId);
      }
      for (const request of this.requests.values()) {
        if (!request.finished) throw new Error("Legacy attempt audit requires stopped requests");
        if (audited.get(request.identity.attemptId) !== request.identity.executionId) throw new Error("Legacy attempt audit omits a recorded request");
      }
    } else if (event.type === "attempt") {
      fields(event, ["type", "executionId", "attemptId"]);
      if (!validId(event.executionId) || !validId(event.attemptId) || this.limits.maxAttemptsPerExecution === undefined) throw new Error("Invalid attempt admission");
      if (this.attempts.has(event.attemptId)) throw new EvalAdmissionError("Eval attempt already admitted");
      if (now >= Date.parse(this.limits.deadlineAt)) throw new EvalAdmissionError("Eval campaign deadline reached");
      if ([...this.attempts.values()].filter(id => id === event.executionId).length >= this.limits.maxAttemptsPerExecution) throw new EvalAdmissionError("Eval campaign attempt cap reached");
    } else if (event.type === "reserve") {
      fields(event, ["type", "requestId", "identity", "maxUsd", "bound"]);
      if (event.bound !== undefined) validateReservationBound(event.bound, event.identity.phase === "infrastructure");
      fields(event.identity, ["executionId", "attemptId", "phase", "runId"]);
      if (!validId(event.requestId) || !validId(event.identity.executionId) || !validId(event.identity.attemptId)
          || event.identity.runId !== undefined && !validId(event.identity.runId)
          || !["setup", "agent", "judge", "feedback_review", "tool", "infrastructure"].includes(event.identity.phase)) throw new Error("Invalid request identity");
      if (this.limits.maxAttemptsPerExecution !== undefined && this.attempts.get(event.identity.attemptId) !== event.identity.executionId) throw new EvalAdmissionError("Eval request has no admitted attempt");
      if (this.requests.has(event.requestId)) throw new Error("Request already reserved");
      if (amount(event.maxUsd) <= 0n) throw new Error("Request reservation must be positive");
      const current = this.snapshot();
      if (now >= Date.parse(this.limits.deadlineAt)) throw new EvalAdmissionError("Eval campaign deadline reached");
      if (this.requests.size >= this.limits.maxRequests) throw new EvalAdmissionError("Eval campaign request cap reached");
      if (current.inflight >= this.limits.maxConcurrent) throw new EvalAdmissionError("Eval campaign concurrency cap reached");
      if (current.conflictingRequests) throw new EvalAdmissionError("Eval cost receipts conflict; admission stopped");
      if (amount(current.committedUsd) + amount(event.maxUsd) > amount(this.limits.maxUsd)) throw new EvalAdmissionError("Eval campaign spending cap reached");
    } else if (event.type === "observe") {
      const o = event.observation;
      fields(o, ["observationId", "requestId", "source", "provider", "model", "providerRequestId", "currency", "route", "classification", "costUsd", "pricingVersion", "tokens", "final"]);
      if (o.tokens) fields(o.tokens, ["input", "cachedRead", "cachedWrite", "output", "reasoning"]);
      if (!this.requests.has(o.requestId) || !validId(o.observationId) || !validId(o.provider)
          || o.model !== undefined && !validId(o.model) || o.providerRequestId !== undefined && !validId(o.providerRequestId)
          || o.currency !== "USD" || !Object.hasOwn(ranks, o.classification) || typeof o.final !== "boolean"
          || !["provider", "gateway", "native_otlp", "heartbeat", "infrastructure", "invoice"].includes(o.source)
          || !["direct", "braintrust", "other_gateway", "subscription", "infrastructure"].includes(o.route)) throw new Error("Invalid cost observation");
      if (o.classification === "unknown" ? o.costUsd !== undefined : o.costUsd === undefined) throw new Error("Cost classification requires an explicit amount or unknown");
      if (o.costUsd !== undefined) amount(o.costUsd);
      if ((o.classification === "estimated" || o.classification === "allocated") && !validId(o.pricingVersion)) throw new Error("Estimate requires pricing provenance");
      if (o.tokens && (Object.values(o.tokens).some(value => !Number.isSafeInteger(value) || Number(value) < 0)
          || o.tokens.reasoning !== undefined && o.tokens.output !== undefined && o.tokens.reasoning > o.tokens.output)) throw new Error("Invalid normalized token usage");
      const previous = this.observations.get(o.observationId);
      if (previous && digest(previous) !== digest(o)) throw new Error("Observation identity conflict");
      if (o.providerRequestId) {
        const request = this.providerRequests.get(`${o.provider}:${o.providerRequestId}`);
        if (request && request !== o.requestId) throw new Error("Provider request belongs to another reservation; reconcile identities before import");
      }
    } else if (event.type === "invalidate_bound") {
      fields(event, ["type", "requestId"]);
      if (!this.requests.get(event.requestId)?.bound) throw new Error("Cannot invalidate an absent reservation bound");
    } else if (event.type === "finish") {
      if (!this.requests.has(event.requestId) || !["succeeded", "failed", "cancelled"].includes(event.outcome)) throw new Error("Invalid request completion");
    } else throw new Error("Unknown ledger event");
  }
  apply(event: Event) {
    if (event.type === "attempt_policy") {
      this.limits.maxAttemptsPerExecution = event.maxAttemptsPerExecution;
      for (const attempt of event.priorAttempts) this.attempts.set(attempt.attemptId, attempt.executionId);
    } else if (event.type === "attempt") this.attempts.set(event.attemptId, event.executionId);
    else if (event.type === "reserve") this.requests.set(event.requestId, { identity: event.identity, reserved: amount(event.maxUsd), observations: [], finished: false, ...(event.bound ? { bound: event.bound } : {}) });
    else if (event.type === "observe") {
      const o = event.observation;
      if (this.observations.has(o.observationId)) return;
      this.observations.set(o.observationId, o);
      this.requests.get(o.requestId)!.observations.push(o);
      if (o.providerRequestId) this.providerRequests.set(`${o.provider}:${o.providerRequestId}`, o.requestId);
    } else if (event.type === "invalidate_bound") this.requests.get(event.requestId)!.boundInvalidated = true;
    else if (event.type === "finish") this.requests.get(event.requestId)!.finished = true;
  }
}

export async function readEvalCostLedger(file: string) {
  return parseEvalCostLedger(await readFile(file, "utf8"));
}

export function parseEvalCostLedger(raw: string) {
  if (!raw.endsWith("\n")) throw new Error("Eval ledger has an incomplete durable record");
  const lines = raw.trimEnd().split("\n").map(value => JSON.parse(value) as Line);
  let previous = "", state: EvalSpendState | undefined;
  for (const [index, line] of lines.entries()) {
    const { hash, ...body } = line;
    if (line.seq !== index || line.previous !== previous || digest(body) !== hash || !Number.isFinite(Date.parse(line.at))) throw new Error("Eval ledger integrity check failed");
    if (index === 0) {
      if (line.event.type !== "campaign") throw new Error("Eval ledger lacks campaign limits");
      state = new EvalSpendState(line.event.limits);
    } else {
      if (line.event.type === "attempt_policy" && line.event.previousJournalHash !== previous) throw new Error("Legacy attempt audit checkpoint changed");
      state!.validate(line.event, Date.parse(line.at));
      state!.apply(line.event);
    }
    previous = hash;
  }
  return { state: state!, sequence: lines.length, previous };
}

export async function openEvalCostLedger(file: string, limits: EvalSpendLimits) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`;
  let lock: FileHandle;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new Error("Eval ledger writer lock unavailable; inspect prior writer before recovery"); }
  let handle: FileHandle | undefined;
  try {
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
    let state = new EvalSpendState(limits), sequence = 0, previous = "";
    try {
      const loaded = await readEvalCostLedger(file);
      if (digest(loaded.state.limits) !== digest(limits)) throw new Error("Eval campaign limits changed during resume");
      ({ state, sequence, previous } = loaded);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const write = async (event: Event, at = Date.now()) => {
      const body = { seq: sequence, at: new Date(at).toISOString(), previous, event };
      const hash = digest(body);
      await handle!.appendFile(`${JSON.stringify({ ...body, hash })}\n`);
      await handle!.sync();
      previous = hash;
      sequence++;
    };
    if (!sequence) await write({ type: "campaign", limits });
    let queue = Promise.resolve(), closed = false, poisoned = false;
    const append = (event: Event) => {
      if (closed) return Promise.reject(new Error("Eval ledger writer unavailable"));
      const operation = queue.then(async () => {
        if (poisoned) throw new Error("Eval ledger writer unavailable");
        const admittedAt = Date.now();
        if (event.type === "attempt_policy" && event.previousJournalHash !== previous) throw new Error("Legacy attempt audit checkpoint changed");
        state.validate(event, admittedAt);
        try { await write(event, admittedAt); } catch (error) { poisoned = true; throw error; }
        state.apply(event);
      });
      queue = operation.catch(() => {});
      return operation;
    };
    return {
      adoptLegacyAttemptPolicy: (audit: EvalLegacyAttemptAudit) => append({ ...structuredClone(audit), type: "attempt_policy" }),
      admitAttempt: (executionId: string, attemptId: string) => append({ type: "attempt", executionId, attemptId }),
      reserve: (requestId: string, identity: EvalChargeIdentity, maxUsd: string, bound?: EvalReservationBound) => append({ type: "reserve", requestId, identity: structuredClone(identity), maxUsd, ...(bound ? { bound: structuredClone(bound) } : {}) }),
      invalidateBound: (requestId: string) => append({ type: "invalidate_bound", requestId }),
      observe: (observation: EvalCostObservation) => append({ type: "observe", observation: structuredClone(observation) }),
      finish: (requestId: string, outcome: "succeeded" | "failed" | "cancelled") => append({ type: "finish", requestId, outcome }),
      snapshot: () => state.snapshot(),
      async close() {
        if (closed) return;
        closed = true;
        await queue;
        try { await handle!.close(); } finally { await lock.close(); await rm(lockPath); }
      },
    };
  } catch (error) {
    await handle?.close();
    await lock.close();
    await rm(lockPath);
    throw error;
  }
}
