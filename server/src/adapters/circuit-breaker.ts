import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, issues, type Db } from "@paperclipai/db";
import { ADAPTER_FAILURE_REASONS, type AdapterFailureReason } from "./adapter-failure-reasons.js";
import { asBoolean, asNumber, parseObject } from "./utils.js";

export type CircuitKey = string;
export type CircuitLifecycleState = "Closed" | "Open" | "Half-Open";
export type CircuitExecutionAction = "execute" | "defer" | "probe";

export type CircuitExecutionDecision = {
  key: CircuitKey | null;
  state: CircuitLifecycleState;
  action: CircuitExecutionAction;
  resumeAt: string | null;
  shadowMode: boolean;
  effectiveThreshold: number;
};

export type CircuitState = {
  key: CircuitKey;
  state: CircuitLifecycleState;
  resumeAt: string | null;
  openedAt: string | null;
  closedAt: string | null;
  effectiveThreshold: number;
  defaultThreshold: number;
  shadowMode: boolean;
  lastFailureReason: AdapterFailureReason | null;
};

export type AdapterQuarantineBadgeState = {
  resumeAt: string | null;
};

type ResolvedCircuitConfig = {
  enabled: boolean;
  key: CircuitKey;
  shadowMode: boolean;
  defaultThreshold: number;
  windowMs: number;
  quarantineDurationMs: number;
  reTripGraceMs: number;
};

type InternalCircuitState = {
  key: CircuitKey;
  state: CircuitLifecycleState;
  resumeAt: number | null;
  openedAt: number | null;
  closedAt: number | null;
  effectiveThreshold: number;
  defaultThreshold: number;
  shadowMode: boolean;
  lastFailureReason: AdapterFailureReason | null;
  failureTimestamps: number[];
  probeInFlight: boolean;
  windowMs: number;
  quarantineDurationMs: number;
  reTripGraceMs: number;
  reTripResetAt: number | null;
};

type CircuitStateLookup = {
  key: CircuitKey;
  state: InternalCircuitState;
};

type AdapterCircuitAgent = {
  id: string;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
};

type IssueExecutionQuarantinePayload = {
  adapterType: string;
  circuitKey: string;
  routeKey: string;
  state: "open" | "halfOpen";
  trippedAt: string;
  resumeAt: string | null;
  reason: string | null;
};

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_SEC = 60;
const DEFAULT_QUARANTINE_SEC = 300;
const DEFAULT_RETRIP_GRACE_SEC = 300;

const registry = new Map<CircuitKey, InternalCircuitState>();
const probeLeases = new Map<string, string>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

function readPositiveInteger(value: unknown, fallback: number) {
  const parsed = Math.round(asNumber(value, fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveCircuitConfig(adapterType: string | null | undefined, adapterConfig: unknown): ResolvedCircuitConfig {
  const normalizedType = typeof adapterType === "string" && adapterType.trim().length > 0
    ? adapterType.trim()
    : "unknown";
  const config = parseObject(adapterConfig);
  const breaker = parseObject(config.circuitBreaker);

  return {
    enabled: asBoolean(breaker.enabled, true),
    key: buildCircuitKey({ adapterType: normalizedType, adapterConfig }),
    shadowMode: asBoolean(breaker.shadowMode, false),
    defaultThreshold: readPositiveInteger(breaker.threshold, DEFAULT_THRESHOLD),
    windowMs: readPositiveInteger(breaker.windowSec ?? breaker.failureWindowSec, DEFAULT_WINDOW_SEC) * 1000,
    quarantineDurationMs: readPositiveInteger(breaker.quarantineDurationSec, DEFAULT_QUARANTINE_SEC) * 1000,
    reTripGraceMs: readPositiveInteger(breaker.reTripGraceSec, DEFAULT_RETRIP_GRACE_SEC) * 1000,
  };
}

function createInitialState(config: ResolvedCircuitConfig): InternalCircuitState {
  return {
    key: config.key,
    state: "Closed",
    resumeAt: null,
    openedAt: null,
    closedAt: null,
    effectiveThreshold: config.defaultThreshold,
    defaultThreshold: config.defaultThreshold,
    shadowMode: config.shadowMode,
    lastFailureReason: null,
    failureTimestamps: [],
    probeInFlight: false,
    windowMs: config.windowMs,
    quarantineDurationMs: config.quarantineDurationMs,
    reTripGraceMs: config.reTripGraceMs,
    reTripResetAt: null,
  };
}

function getOrCreateState(config: ResolvedCircuitConfig) {
  const existing = registry.get(config.key);
  if (existing) {
    existing.defaultThreshold = config.defaultThreshold;
    existing.shadowMode = config.shadowMode;
    existing.windowMs = config.windowMs;
    existing.quarantineDurationMs = config.quarantineDurationMs;
    existing.reTripGraceMs = config.reTripGraceMs;
    return existing;
  }

  const created = createInitialState(config);
  registry.set(config.key, created);
  return created;
}

function applyTimers(state: InternalCircuitState, now: number) {
  if (
    state.state === "Closed"
    && state.reTripResetAt !== null
    && now >= state.reTripResetAt
    && state.effectiveThreshold !== state.defaultThreshold
  ) {
    state.effectiveThreshold = state.defaultThreshold;
    state.reTripResetAt = null;
  }

  if (state.state === "Open" && state.resumeAt !== null && now >= state.resumeAt) {
    state.state = "Half-Open";
    state.resumeAt = null;
    state.probeInFlight = false;
  }
}

function toPublicState(state: InternalCircuitState): CircuitState {
  return {
    key: state.key,
    state: state.state,
    resumeAt: state.resumeAt === null ? null : new Date(state.resumeAt).toISOString(),
    openedAt: state.openedAt === null ? null : new Date(state.openedAt).toISOString(),
    closedAt: state.closedAt === null ? null : new Date(state.closedAt).toISOString(),
    effectiveThreshold: state.effectiveThreshold,
    defaultThreshold: state.defaultThreshold,
    shadowMode: state.shadowMode,
    lastFailureReason: state.lastFailureReason,
  };
}

function toProbeLeaseKey(input: string) {
  if (input.startsWith("adapter:")) {
    return input.slice("adapter:".length);
  }
  if (!input.includes(":")) {
    return input;
  }
  return input.split(":", 1)[0] ?? input;
}

function resolveStateLookup(input: CircuitKey): CircuitStateLookup | null {
  const direct = registry.get(input);
  if (direct) {
    return { key: input, state: direct };
  }

  const adapterType = toProbeLeaseKey(input);
  for (const [key, state] of registry.entries()) {
    if (key.startsWith(`${adapterType}:`)) {
      return { key, state };
    }
  }

  return null;
}

function normalizeAdapterFailureReason(reason: string | null | undefined): AdapterFailureReason {
  if (typeof reason === "string" && reason in ADAPTER_FAILURE_REASONS) {
    return reason as AdapterFailureReason;
  }
  return "adapter_protocol_error";
}

function withIssueExecutionQuarantineState(
  executionState: unknown,
  payload: IssueExecutionQuarantinePayload | null,
): Record<string, unknown> | null {
  const baseState = parseObject(executionState);
  if (payload) {
    return {
      ...baseState,
      quarantineHold: payload,
    };
  }

  if (!("quarantineHold" in baseState)) {
    return Object.keys(baseState).length > 0 ? baseState : null;
  }

  const { quarantineHold: _quarantineHold, ...rest } = baseState;
  return Object.keys(rest).length > 0 ? rest : null;
}

async function findAgentsForAdapterType(db: Db, adapterType: string): Promise<AdapterCircuitAgent[]> {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(eq(agents.adapterType, adapterType));
}

async function upsertDeferredWake(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    circuitKey: string;
    routeKey: string;
    resumeAt: string | null;
    reason: string | null;
  },
) {
  const scheduledAt = input.resumeAt ? new Date(input.resumeAt) : null;
  const deferredPayload = {
    issueId: input.issueId,
    circuitBreaker: {
      key: input.circuitKey,
      routeKey: input.routeKey,
      resumeAt: input.resumeAt,
      reason: input.reason,
    },
  };

  const existing = await db
    .select({
      id: agentWakeupRequests.id,
      coalescedCount: agentWakeupRequests.coalescedCount,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        or(
          eq(agentWakeupRequests.issueId, input.issueId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing) {
    await db
      .update(agentWakeupRequests)
      .set({
        issueId: input.issueId,
        payload: deferredPayload,
        scheduledAt,
        reason: "adapter_quarantined",
        coalescedCount: (existing.coalescedCount ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, existing.id));
    return;
  }

  await db.insert(agentWakeupRequests).values({
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    source: "automation",
    triggerDetail: "system",
    reason: "adapter_quarantined",
    payload: deferredPayload,
    status: "deferred_issue_execution",
    scheduledAt,
  });
}

async function stampIssueQuarantine(
  db: Db,
  input: {
    agent: AdapterCircuitAgent;
    circuitKey: string;
    routeKey: string;
    resumeAt: string | null;
    reason: string | null;
  },
) {
  const now = new Date();
  const holdPayload: IssueExecutionQuarantinePayload = {
    adapterType: input.agent.adapterType,
    circuitKey: input.circuitKey,
    routeKey: input.routeKey,
    state: "open",
    trippedAt: now.toISOString(),
    resumeAt: input.resumeAt,
    reason: input.reason,
  };

  const assignedIssues = await db
    .select({
      id: issues.id,
      executionRunId: issues.executionRunId,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(eq(issues.assigneeAgentId, input.agent.id));

  for (const issue of assignedIssues) {
    await db
      .update(issues)
      .set({
        quarantineHold: true,
        executionState: withIssueExecutionQuarantineState(issue.executionState, holdPayload),
        updatedAt: now,
      })
      .where(eq(issues.id, issue.id));

    if (issue.executionRunId) {
      await upsertDeferredWake(db, {
        companyId: input.agent.companyId,
        agentId: input.agent.id,
        issueId: issue.id,
        circuitKey: input.circuitKey,
        routeKey: input.routeKey,
        resumeAt: input.resumeAt,
        reason: input.reason,
      });
    }
  }
}

async function clearIssueQuarantine(
  db: Db,
  input: {
    agentIds: string[];
    circuitKey: string;
  },
) {
  const now = new Date();
  const assignedIssues = await db
    .select({
      id: issues.id,
      assigneeAgentId: issues.assigneeAgentId,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(inArray(issues.assigneeAgentId, input.agentIds));

  let cleared = 0;
  for (const issue of assignedIssues) {
    const currentState = parseObject(issue.executionState);
    const hold = parseObject(currentState.quarantineHold);
    if (hold.circuitKey !== input.circuitKey) {
      continue;
    }

    await db
      .update(issues)
      .set({
        quarantineHold: false,
        executionState: withIssueExecutionQuarantineState(issue.executionState, null),
        updatedAt: now,
      })
      .where(eq(issues.id, issue.id));
    cleared += 1;
  }

  return cleared;
}

function openCircuit(state: InternalCircuitState, now: number) {
  state.state = "Open";
  state.openedAt = now;
  state.resumeAt = now + state.quarantineDurationMs;
  state.failureTimestamps = [];
  state.probeInFlight = false;
}

export function buildCircuitKey(input: {
  adapterType: string | null | undefined;
  adapterConfig: unknown;
}): CircuitKey {
  const adapterType = typeof input.adapterType === "string" && input.adapterType.trim().length > 0
    ? input.adapterType.trim()
    : "unknown";

  if (adapterType === "process" || adapterType === "http") {
    const digest = createHash("sha256")
      .update(stableStringify(parseObject(input.adapterConfig)))
      .digest("hex")
      .slice(0, 12);
    return `${adapterType}:config:${digest}`;
  }

  return `${adapterType}:module`;
}

export function getCircuitQuarantineDurationMs(input: {
  adapterType: string | null | undefined;
  adapterConfig: unknown;
}): number {
  return resolveCircuitConfig(input.adapterType, input.adapterConfig).quarantineDurationMs;
}

export function getCircuitExecutionDecision(input: {
  adapterType: string | null | undefined;
  adapterConfig: unknown;
  now?: Date;
}): CircuitExecutionDecision {
  const config = resolveCircuitConfig(input.adapterType, input.adapterConfig);
  if (!config.enabled) {
    return {
      key: null,
      state: "Closed",
      action: "execute",
      resumeAt: null,
      shadowMode: config.shadowMode,
      effectiveThreshold: config.defaultThreshold,
    };
  }

  const state = getOrCreateState(config);
  const now = (input.now ?? new Date()).getTime();
  applyTimers(state, now);

  if (state.state === "Open") {
    return {
      key: state.key,
      state: state.state,
      action: "defer",
      resumeAt: state.resumeAt === null ? null : new Date(state.resumeAt).toISOString(),
      shadowMode: state.shadowMode,
      effectiveThreshold: state.effectiveThreshold,
    };
  }

  if (state.state === "Half-Open") {
    if (state.probeInFlight) {
      return {
        key: state.key,
        state: state.state,
        action: "defer",
        resumeAt: null,
        shadowMode: state.shadowMode,
        effectiveThreshold: state.effectiveThreshold,
      };
    }

    state.probeInFlight = true;
    return {
      key: state.key,
      state: state.state,
      action: "probe",
      resumeAt: null,
      shadowMode: state.shadowMode,
      effectiveThreshold: state.effectiveThreshold,
    };
  }

  return {
    key: state.key,
    state: state.state,
    action: "execute",
    resumeAt: null,
    shadowMode: state.shadowMode,
    effectiveThreshold: state.effectiveThreshold,
  };
}

export function recordCircuitExecutionSuccess(input: {
  key: CircuitKey | null;
  adapterType: string | null | undefined;
  adapterConfig: unknown;
  probe?: boolean;
  now?: Date;
}) {
  if (!input.key) return null;
  const config = resolveCircuitConfig(input.adapterType, input.adapterConfig);
  const state = getOrCreateState(config);
  const now = (input.now ?? new Date()).getTime();
  applyTimers(state, now);
  state.failureTimestamps = [];
  state.probeInFlight = false;
  state.lastFailureReason = null;

  if (state.state === "Half-Open" || input.probe) {
    state.state = "Closed";
    state.closedAt = now;
    state.openedAt = null;
    state.resumeAt = null;
    state.effectiveThreshold = Math.max(1, Math.ceil(state.effectiveThreshold / 2));
    state.reTripResetAt = now + state.reTripGraceMs;
  }

  applyTimers(state, now);
  return toPublicState(state);
}

export function recordCircuitExecutionFailure(input: {
  key: CircuitKey | null;
  adapterType: string | null | undefined;
  adapterConfig: unknown;
  adapterFailureReason: AdapterFailureReason;
  probe?: boolean;
  now?: Date;
}) {
  if (!input.key) return null;
  const config = resolveCircuitConfig(input.adapterType, input.adapterConfig);
  const state = getOrCreateState(config);
  const now = (input.now ?? new Date()).getTime();
  applyTimers(state, now);
  state.lastFailureReason = input.adapterFailureReason;

  if (state.state === "Half-Open" || input.probe) {
    if (state.shadowMode) {
      state.state = "Closed";
      state.closedAt = now;
      state.probeInFlight = false;
      state.failureTimestamps = [];
      return toPublicState(state);
    }

    openCircuit(state, now);
    return toPublicState(state);
  }

  if (!ADAPTER_FAILURE_REASONS[input.adapterFailureReason].countsTowardBreaker) {
    return toPublicState(state);
  }

  state.failureTimestamps = state.failureTimestamps.filter((timestamp) => now - timestamp <= state.windowMs);
  state.failureTimestamps.push(now);

  if (state.failureTimestamps.length >= state.effectiveThreshold) {
    if (state.shadowMode) {
      return toPublicState(state);
    }
    openCircuit(state, now);
  }

  return toPublicState(state);
}

export function getCircuitState(key: CircuitKey, now = new Date()) {
  const lookup = resolveStateLookup(key);
  if (!lookup) return null;
  applyTimers(lookup.state, now.getTime());
  return toPublicState(lookup.state);
}

export function getAdapterQuarantineBadgeState(input: {
  adapterType: string | null | undefined;
  adapterConfig: unknown;
  now?: Date;
}): AdapterQuarantineBadgeState | null {
  const config = resolveCircuitConfig(input.adapterType, input.adapterConfig);
  if (!config.enabled) return null;
  const state = getCircuitState(config.key, input.now);
  if (!state || state.state === "Closed") return null;
  return {
    resumeAt: state.resumeAt,
  };
}

export function getEffectiveThreshold(key: CircuitKey, now = new Date()) {
  const lookup = resolveStateLookup(key);
  if (!lookup) return DEFAULT_THRESHOLD;
  applyTimers(lookup.state, now.getTime());
  return lookup.state.effectiveThreshold;
}

export function toRouteKey(key: CircuitKey) {
  const routeTarget = key.includes(":") ? key : `adapter:${key}`;
  return Buffer.from(routeTarget, "utf8").toString("base64url");
}

export function advanceToHalfOpen(key: CircuitKey) {
  const lookup = resolveStateLookup(key);
  if (!lookup) return null;
  lookup.state.state = "Half-Open";
  lookup.state.resumeAt = null;
  lookup.state.probeInFlight = false;
  return toPublicState(lookup.state);
}

export function advancePastReTripGrace(key: CircuitKey) {
  const lookup = resolveStateLookup(key);
  if (!lookup) return null;
  lookup.state.reTripResetAt = 0;
  applyTimers(lookup.state, Date.now());
  return toPublicState(lookup.state);
}

export function resetCircuit(key: CircuitKey, now = new Date()) {
  const lookup = resolveStateLookup(key);
  if (!lookup) return null;
  lookup.state.state = "Closed";
  lookup.state.resumeAt = null;
  lookup.state.openedAt = null;
  lookup.state.closedAt = now.getTime();
  lookup.state.effectiveThreshold = lookup.state.defaultThreshold;
  lookup.state.lastFailureReason = null;
  lookup.state.failureTimestamps = [];
  lookup.state.probeInFlight = false;
  lookup.state.reTripResetAt = null;
  return toPublicState(lookup.state);
}

export function resetAllCircuits() {
  registry.clear();
  probeLeases.clear();
}

export function probeLeaseHeld(keyOrAdapterType: CircuitKey) {
  return probeLeases.has(toProbeLeaseKey(keyOrAdapterType));
}

export function getAllCircuitStates(now = new Date()) {
  return [...registry.values()]
    .map((state) => {
      applyTimers(state, now.getTime());
      return toPublicState(state);
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function recordFailure(input: {
  adapterType: string | null | undefined;
  adapterConfig: unknown;
  adapterFailureReason: AdapterFailureReason;
  now?: Date;
}) {
  const key = buildCircuitKey({
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig,
  });
  return recordCircuitExecutionFailure({
    key,
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig,
    adapterFailureReason: input.adapterFailureReason,
    now: input.now,
  });
}

export function recordProbeResult(input: {
  adapterType: string | null | undefined;
  adapterConfig: unknown;
  ok: boolean;
  now?: Date;
}) {
  const key = buildCircuitKey({
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig,
  });
  if (input.ok) {
    return recordCircuitExecutionSuccess({
      key,
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      probe: true,
      now: input.now,
    });
  }

  return recordCircuitExecutionFailure({
    key,
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig,
    adapterFailureReason: "adapter_protocol_error",
    probe: true,
    now: input.now,
  });
}

export function forceQuarantine(input: {
  adapterType: string | null | undefined;
  adapterConfig: unknown;
  reason?: string | null;
  now?: Date;
}) {
  const config = resolveCircuitConfig(input.adapterType, input.adapterConfig);
  const state = getOrCreateState(config);
  const at = (input.now ?? new Date()).getTime();
  state.lastFailureReason = normalizeAdapterFailureReason(input.reason);
  openCircuit(state, at);
  return toPublicState(state);
}

export function resetBreaker(input: {
  adapterType: string | null | undefined;
  adapterConfig: unknown;
  now?: Date;
}) {
  const key = buildCircuitKey({
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig,
  });
  return resetCircuit(key, input.now);
}

export function _resetForTesting() {
  resetAllCircuits();
}

export async function recordAdapterFailure(
  db: Db,
  input: { adapterType: string; agentId: string; reason: string | null | undefined },
): Promise<{ tripped: boolean }> {
  const agent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.adapterType, input.adapterType)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!agent) {
    return { tripped: false };
  }

  const circuitKey = buildCircuitKey({
    adapterType: agent.adapterType,
    adapterConfig: agent.adapterConfig,
  });
  const previous = getCircuitState(circuitKey);
  const next = recordCircuitExecutionFailure({
    key: circuitKey,
    adapterType: agent.adapterType,
    adapterConfig: agent.adapterConfig,
    adapterFailureReason: normalizeAdapterFailureReason(input.reason),
  });
  const tripped = previous?.state !== "Open" && next?.state === "Open";
  if (!tripped || !next) {
    return { tripped: false };
  }

  const routeKey = toRouteKey(circuitKey);
  await db
    .update(agents)
    .set({
      status: "quarantined",
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agent.id));

  await stampIssueQuarantine(db, {
    agent,
    circuitKey,
    routeKey,
    resumeAt: next.resumeAt,
    reason: input.reason ?? null,
  });

  return { tripped: true };
}

export async function runProbeRound(
  db: Db,
  adapterType: string,
  input: { ok: boolean },
): Promise<{ released: boolean; probeExecuted: boolean }> {
  const leaseKey = toProbeLeaseKey(adapterType);
  if (probeLeases.has(leaseKey)) {
    return { released: false, probeExecuted: false };
  }

  const leaseId = randomUUID();
  probeLeases.set(leaseKey, leaseId);

  try {
    const adapterAgents = await findAgentsForAdapterType(db, adapterType);
    if (adapterAgents.length === 0) {
      return { released: false, probeExecuted: false };
    }

    const keyedAgents = adapterAgents.map((agent) => ({
      ...agent,
      circuitKey: buildCircuitKey({
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
      }),
    }));
    const candidate =
      keyedAgents.find((agent) => getCircuitState(agent.circuitKey)?.state === "Half-Open")
      ?? keyedAgents.find((agent) => getCircuitState(agent.circuitKey)?.state === "Open")
      ?? keyedAgents[0];

    if (!candidate) {
      return { released: false, probeExecuted: false };
    }

    const before = getCircuitState(candidate.circuitKey);
    if (!before || (before.state !== "Half-Open" && before.state !== "Open")) {
      return { released: false, probeExecuted: false };
    }

    const next = input.ok
      ? recordCircuitExecutionSuccess({
        key: candidate.circuitKey,
        adapterType: candidate.adapterType,
        adapterConfig: candidate.adapterConfig,
        probe: true,
      })
      : recordCircuitExecutionFailure({
        key: candidate.circuitKey,
        adapterType: candidate.adapterType,
        adapterConfig: candidate.adapterConfig,
        adapterFailureReason: "adapter_protocol_error",
        probe: true,
      });

    if (!next) {
      return { released: false, probeExecuted: true };
    }

    const matchingAgentIds = keyedAgents
      .filter((agent) => agent.circuitKey === candidate.circuitKey)
      .map((agent) => agent.id);

    if (next.state === "Closed") {
      if (matchingAgentIds.length > 0) {
        await db
          .update(agents)
          .set({
            status: "running",
            updatedAt: new Date(),
          })
          .where(inArray(agents.id, matchingAgentIds));
      }

      const cleared = matchingAgentIds.length > 0
        ? await clearIssueQuarantine(db, {
          agentIds: matchingAgentIds,
          circuitKey: candidate.circuitKey,
        })
        : 0;

      return { released: cleared > 0, probeExecuted: true };
    }

    if (next.state === "Open") {
      const routeKey = toRouteKey(candidate.circuitKey);
      if (matchingAgentIds.length > 0) {
        await db
          .update(agents)
          .set({
            status: "quarantined",
            updatedAt: new Date(),
          })
          .where(inArray(agents.id, matchingAgentIds));
      }

      for (const agent of keyedAgents) {
        if (agent.circuitKey !== candidate.circuitKey) {
          continue;
        }
        await stampIssueQuarantine(db, {
          agent,
          circuitKey: candidate.circuitKey,
          routeKey,
          resumeAt: next.resumeAt,
          reason: next.lastFailureReason,
        });
      }
    }

    return { released: false, probeExecuted: true };
  } finally {
    if (probeLeases.get(leaseKey) === leaseId) {
      probeLeases.delete(leaseKey);
    }
  }
}
