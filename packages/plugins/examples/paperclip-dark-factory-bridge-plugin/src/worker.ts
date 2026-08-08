import { createHash } from "node:crypto";
import { definePlugin, runWorker, type PluginApiRequestInput } from "@paperclipai/plugin-sdk";

export const PROJECTION_DISCLAIMER = "Projection only — Dark Factory Journal remains truth source";

type ProjectionStatus = "current" | "degraded" | "blocked" | "needs_approval";
type BreakerState = "closed" | "open" | "half_open";

type ProjectionEnvelope = {
  source: "dark-factory-projection";
  truthSource: "dark-factory-journal";
  authoritative: false;
  disclaimer: string;
  issueId: string;
  linkedRunId: string;
  projectionId: string;
  projectionStatus: ProjectionStatus;
  journalCursor: JournalCursor;
  callbackReceipt: CallbackReceipt;
  flags: {
    degraded: boolean;
    blocked: boolean;
    needsApproval: boolean;
  };
  lastUpdatedAt: string;
};

type JournalCursor = {
  cursorId: string;
  runId: string;
  lastJournalSequenceNo: number;
  journalRef: string;
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
  providerRole: "primary_execution";
  breakerState: BreakerState;
  lastUpdatedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  openReason: string | null;
  cooldownUntil: string | null;
};

type ProjectionSummary = {
  source: "dark-factory-projection";
  truthSource: "dark-factory-journal";
  authoritative: false;
  disclaimer: string;
  projection: ProjectionEnvelope;
  providerHealth: ProviderHealth;
};

function stableInt(input: string, modulo: number): number {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) % modulo;
}

function isoFromOffset(input: string, minutesOffset = 0): string {
  const base = Date.UTC(2026, 0, 15, 12, 0, 0);
  const offset = stableInt(input, 1440) + minutesOffset;
  return new Date(base + offset * 60_000).toISOString();
}

function runId(issueId: string): string {
  return `df-run-${issueId.slice(0, 8)}`;
}

function statusFor(issueId: string): ProjectionStatus {
  return (["current", "degraded", "blocked", "needs_approval"] as const)[stableInt(issueId, 4)];
}

function breakerFor(issueId: string): BreakerState {
  return (["closed", "half_open", "open"] as const)[stableInt(`${issueId}:breaker`, 3)];
}

function buildCursor(issueId: string): JournalCursor {
  const linkedRunId = runId(issueId);
  const lastJournalSequenceNo = 100 + stableInt(`${issueId}:cursor`, 900);
  return {
    cursorId: `df-cursor-${issueId.slice(0, 8)}`,
    runId: linkedRunId,
    lastJournalSequenceNo,
    journalRef: `dark-factory://journal/${linkedRunId}#${lastJournalSequenceNo}`,
    monotonic: true,
    gapDetected: false,
  };
}

function buildProjection(issueId: string): ProjectionEnvelope {
  const projectionStatus = statusFor(issueId);
  const linkedRunId = runId(issueId);
  const cursor = buildCursor(issueId);
  return {
    source: "dark-factory-projection",
    truthSource: "dark-factory-journal",
    authoritative: false,
    disclaimer: PROJECTION_DISCLAIMER,
    issueId,
    linkedRunId,
    projectionId: `df-projection-${issueId.slice(0, 8)}`,
    projectionStatus,
    journalCursor: cursor,
    callbackReceipt: {
      receiptId: `df-callback-${issueId.slice(0, 8)}-${cursor.lastJournalSequenceNo}`,
      status: "observed",
      terminalStateAdvanced: false,
      idempotencyKey: `${linkedRunId}:${cursor.lastJournalSequenceNo}`,
    },
    flags: {
      degraded: projectionStatus === "degraded",
      blocked: projectionStatus === "blocked",
      needsApproval: projectionStatus === "needs_approval",
    },
    lastUpdatedAt: isoFromOffset(issueId),
  };
}

function buildProviderHealth(issueId: string): ProviderHealth {
  const breakerState = breakerFor(issueId);
  return {
    providerRole: "primary_execution",
    breakerState,
    lastUpdatedAt: isoFromOffset(`${issueId}:health`, 3),
    lastSuccessAt: breakerState === "open" ? null : isoFromOffset(`${issueId}:success`, -20),
    lastFailureAt: breakerState === "closed" ? null : isoFromOffset(`${issueId}:failure`, -7),
    openReason: breakerState === "open" ? "mock_provider_timeout_threshold" : null,
    cooldownUntil: breakerState === "open" ? isoFromOffset(`${issueId}:cooldown`, 30) : null,
  };
}

function buildSummary(issueId: string): ProjectionSummary {
  return {
    source: "dark-factory-projection",
    truthSource: "dark-factory-journal",
    authoritative: false,
    disclaimer: PROJECTION_DISCLAIMER,
    projection: buildProjection(issueId),
    providerHealth: buildProviderHealth(issueId),
  };
}

function buildRehydrateReceipt(issueId: string, reason?: string | null) {
  const linkedRunId = runId(issueId);
  return {
    source: "dark-factory-projection" as const,
    truthSource: "dark-factory-journal" as const,
    authoritative: false as const,
    disclaimer: PROJECTION_DISCLAIMER,
    issueId,
    linkedRunId,
    requestedAt: isoFromOffset(`${issueId}:rehydrate`, 5),
    receipt: {
      receiptId: `df-rehydrate-${linkedRunId}`,
      status: "requested" as const,
      terminalStateAdvanced: false as const,
      idempotencyKey: `${linkedRunId}:rehydrate-request`,
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
      return {
        status: 200,
        body: {
          source: "dark-factory-projection",
          truthSource: "dark-factory-journal",
          authoritative: false,
          disclaimer: PROJECTION_DISCLAIMER,
          issueId,
          cursor: buildCursor(issueId),
        },
      };
    }

    if (input.routeKey === "provider-health") {
      return {
        status: 200,
        body: {
          source: "dark-factory-projection",
          truthSource: "dark-factory-journal",
          authoritative: false,
          disclaimer: PROJECTION_DISCLAIMER,
          issueId,
          observationSource: "runtime_observation",
          providerHealth: buildProviderHealth(issueId),
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
        source: "dark-factory-projection",
        truthSource: "dark-factory-journal",
        authoritative: false,
      },
    };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
