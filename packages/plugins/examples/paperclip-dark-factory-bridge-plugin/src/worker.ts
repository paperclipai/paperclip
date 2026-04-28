import { createHash } from "node:crypto";
import { definePlugin, runWorker, type PluginApiRequestInput } from "@paperclipai/plugin-sdk";

export const PROJECTION_DISCLAIMER = "Projection only — Dark Factory Journal remains truth source";

const PROJECTION_SOURCE = "dark-factory-projection" as const;
const TRUTH_SOURCE = "dark-factory-journal" as const;

type ProjectionStatus = "current" | "degraded" | "blocked" | "needs_approval" | "stale";
type BreakerState = "closed" | "open" | "half_open";

type ProjectionContract = {
  source: typeof PROJECTION_SOURCE;
  authoritative: false;
  truthSource: typeof TRUTH_SOURCE;
  disclaimer: string;
  issueId: string;
  runId: string;
  linkedRunId: string;
  journalCursor: JournalCursor;
  lastSequenceNo: number;
  projectionStatus: ProjectionStatus;
  callbackReceiptId: string;
  staleReason: string | null;
  degradedReason: string | null;
  blockedReason: string | null;
};

type ProjectionEnvelope = ProjectionContract & {
  projectionId: string;
  callbackReceipt: CallbackReceipt;
  sourceJournalRef: string;
  projectionJson: {
    issueId: string;
    runId: string;
    cursor: string;
    status: ProjectionStatus;
  };
  flags: {
    degraded: boolean;
    blocked: boolean;
    needsApproval: boolean;
    stale: boolean;
  };
  lastUpdatedAt: string;
};

type JournalCursor = {
  source: typeof PROJECTION_SOURCE;
  authoritative: false;
  truthSource: typeof TRUTH_SOURCE;
  cursorId: string;
  runId: string;
  journalCursor: string;
  lastSequenceNo: number;
  lastJournalSequenceNo: number;
  journalRef: string;
  sourceJournalRef: string;
  monotonic: true;
  gapDetected: boolean;
};

type CallbackReceipt = {
  receiptId: string;
  status: "observed" | "requested" | "pending";
  terminalStateAdvanced: false;
  idempotencyKey: string;
};

type ProviderHealth = {
  source: typeof PROJECTION_SOURCE;
  authoritative: false;
  truthSource: typeof TRUTH_SOURCE;
  providerRole: "primary_execution";
  modelRole: "execution_model";
  modelSelection: {
    policy: "role_based_runtime_selection";
    protocolMustSpecifyConcreteModel: false;
    configuredModelName: null;
  };
  breakerState: BreakerState;
  lastUpdatedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  openReason: string | null;
  cooldownUntil: string | null;
};

type ProjectionSummary = {
  source: typeof PROJECTION_SOURCE;
  truthSource: typeof TRUTH_SOURCE;
  authoritative: false;
  disclaimer: string;
  journalCursor: JournalCursor;
  lastSequenceNo: number;
  projectionStatus: ProjectionStatus;
  callbackReceiptId: string;
  staleReason: string | null;
  degradedReason: string | null;
  blockedReason: string | null;
  projection: ProjectionEnvelope;
  providerHealth: ProviderHealth;
};

function stableInt(input: string, modulo: number): number {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) % modulo;
}

function isoFromOffset(input: string, minutesOffset = 0): string {
  const boundedMinutes = stableInt(input, 60) + minutesOffset;
  return new Date(Date.now() - boundedMinutes * 60_000).toISOString();
}

function runId(issueId: string): string {
  return `df-run-${issueId.slice(0, 8)}`;
}

function statusFor(issueId: string): ProjectionStatus {
  if (issueId.toLowerCase().includes("stale")) return "stale";
  return (["current", "degraded", "blocked", "needs_approval"] as const)[stableInt(issueId, 4)];
}

function breakerFor(issueId: string): BreakerState {
  return (["closed", "half_open", "open"] as const)[stableInt(`${issueId}:breaker`, 3)];
}

function buildCursor(issueId: string): JournalCursor {
  const linkedRunId = runId(issueId);
  const lastJournalSequenceNo = 100 + stableInt(`${issueId}:cursor`, 900);
  const journalRef = `dark-factory://journal/${linkedRunId}#${lastJournalSequenceNo}`;
  return {
    source: PROJECTION_SOURCE,
    truthSource: TRUTH_SOURCE,
    authoritative: false,
    cursorId: `df-cursor-${issueId.slice(0, 8)}`,
    runId: linkedRunId,
    journalCursor: journalRef,
    lastSequenceNo: lastJournalSequenceNo,
    lastJournalSequenceNo,
    journalRef,
    sourceJournalRef: journalRef,
    monotonic: true,
    gapDetected: false,
  };
}

function reasonsFor(status: ProjectionStatus): Pick<ProjectionContract, "staleReason" | "degradedReason" | "blockedReason"> {
  return {
    staleReason: status === "stale" ? "journal_cursor_lag_detected" : null,
    degradedReason: status === "degraded" || status === "stale" ? "projection_lag_exceeds_mock_threshold" : null,
    blockedReason: status === "blocked" ? "provider_breaker_open_for_projection" : null,
  };
}

function buildContract(issueId: string): ProjectionContract {
  const projectionStatus = statusFor(issueId);
  const cursor = buildCursor(issueId);
  const linkedRunId = cursor.runId;
  return {
    source: PROJECTION_SOURCE,
    truthSource: TRUTH_SOURCE,
    authoritative: false,
    disclaimer: PROJECTION_DISCLAIMER,
    issueId,
    runId: linkedRunId,
    linkedRunId,
    journalCursor: cursor,
    lastSequenceNo: cursor.lastSequenceNo,
    projectionStatus,
    callbackReceiptId: `df-callback-${issueId.slice(0, 8)}-${cursor.lastSequenceNo}`,
    ...reasonsFor(projectionStatus),
  };
}

function buildProjection(issueId: string): ProjectionEnvelope {
  const contract = buildContract(issueId);
  return {
    ...contract,
    projectionId: `df-projection-${issueId.slice(0, 8)}`,
    sourceJournalRef: contract.journalCursor.sourceJournalRef,
    projectionJson: {
      issueId,
      runId: contract.runId,
      cursor: contract.journalCursor.journalCursor,
      status: contract.projectionStatus,
    },
    callbackReceipt: {
      receiptId: contract.callbackReceiptId,
      status: "observed",
      terminalStateAdvanced: false,
      idempotencyKey: `${contract.runId}:${contract.lastSequenceNo}`,
    },
    flags: {
      degraded: contract.projectionStatus === "degraded" || contract.projectionStatus === "stale",
      blocked: contract.projectionStatus === "blocked",
      needsApproval: contract.projectionStatus === "needs_approval",
      stale: contract.projectionStatus === "stale",
    },
    lastUpdatedAt: isoFromOffset(issueId),
  };
}

function buildProviderHealth(issueId: string): ProviderHealth {
  const breakerState = breakerFor(issueId);
  return {
    source: PROJECTION_SOURCE,
    truthSource: TRUTH_SOURCE,
    authoritative: false,
    providerRole: "primary_execution",
    modelRole: "execution_model",
    modelSelection: {
      policy: "role_based_runtime_selection",
      protocolMustSpecifyConcreteModel: false,
      configuredModelName: null,
    },
    breakerState,
    lastUpdatedAt: isoFromOffset(`${issueId}:health`, 3),
    lastSuccessAt: breakerState === "open" ? null : isoFromOffset(`${issueId}:success`, -20),
    lastFailureAt: breakerState === "closed" ? null : isoFromOffset(`${issueId}:failure`, -7),
    openReason: breakerState === "open" ? "mock_provider_timeout_threshold" : null,
    cooldownUntil: breakerState === "open" ? isoFromOffset(`${issueId}:cooldown`, 30) : null,
  };
}

function buildSummary(issueId: string): ProjectionSummary {
  const projection = buildProjection(issueId);
  return {
    source: PROJECTION_SOURCE,
    truthSource: TRUTH_SOURCE,
    authoritative: false,
    disclaimer: PROJECTION_DISCLAIMER,
    journalCursor: projection.journalCursor,
    lastSequenceNo: projection.lastSequenceNo,
    projectionStatus: projection.projectionStatus,
    callbackReceiptId: projection.callbackReceiptId,
    staleReason: projection.staleReason,
    degradedReason: projection.degradedReason,
    blockedReason: projection.blockedReason,
    projection,
    providerHealth: buildProviderHealth(issueId),
  };
}

function buildRehydrateReceipt(issueId: string, reason?: string | null) {
  const contract = buildContract(issueId);
  const receiptId = `df-rehydrate-${contract.runId}`;
  return {
    ...contract,
    callbackReceiptId: receiptId,
    requestedAt: isoFromOffset(`${issueId}:rehydrate`, 5),
    requestSemantics: "receipt_only_not_terminal_success" as const,
    receipt: {
      receiptId,
      status: "requested" as const,
      terminalStateAdvanced: false as const,
      idempotencyKey: `${contract.runId}:rehydrate-request`,
      reason: reason ?? "operator_requested_projection_refresh",
    },
  };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("projection-summary", async (params) => {
      const issueId = stringField(params.issueId) ?? "dashboard-overview";
      return buildSummary(issueId);
    });

    ctx.actions.register("request-rehydrate", async (params) => {
      const issueId = stringField(params.issueId);
      if (!issueId) throw new Error("issueId is required");
      return buildRehydrateReceipt(issueId, stringField(params.reason));
    });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    const issueId = stringField(input.params.issueId);
    if (!issueId) {
      return {
        status: 400,
        body: { error: "issueId is required" },
      };
    }

    if (input.routeKey === "projection") {
      return { status: 200, body: buildProjection(issueId) };
    }

    if (input.routeKey === "journal-cursor") {
      const contract = buildContract(issueId);
      return {
        status: 200,
        body: {
          ...contract,
          cursor: contract.journalCursor,
        },
      };
    }

    if (input.routeKey === "provider-health") {
      const providerHealth = buildProviderHealth(issueId);
      return {
        status: 200,
        body: {
          ...buildContract(issueId),
          observationSource: "runtime_observation",
          providerRole: providerHealth.providerRole,
          modelRole: providerHealth.modelRole,
          modelSelection: providerHealth.modelSelection,
          breakerState: providerHealth.breakerState,
          providerHealth,
        },
      };
    }

    if (input.routeKey === "rehydrate-request") {
      const body = input.body as Record<string, unknown> | null;
      return {
        status: 202,
        body: buildRehydrateReceipt(issueId, stringField(body?.reason)),
      };
    }

    return {
      status: 404,
      body: { error: `Unknown Dark Factory bridge route: ${input.routeKey}` },
    };
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Dark Factory bridge projection mock worker is running",
      details: {
        source: PROJECTION_SOURCE,
        truthSource: TRUTH_SOURCE,
        authoritative: false,
      },
    };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
