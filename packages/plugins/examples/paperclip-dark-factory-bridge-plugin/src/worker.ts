import { definePlugin, runWorker, type PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import {
  DARK_FACTORY_PROJECTION_SOURCE,
  DARK_FACTORY_TRUTH_SOURCE,
  PROJECTION_AUTHORITATIVE,
  PROJECTION_DISCLAIMER,
  RUNTIME_OBSERVATION_SOURCE,
} from "./runtime-contract.js";
import {
  createMockRehydrateRequest,
  getMockJournalCursor,
  getMockProviderHealth,
  getMockRunAttemptMetadata,
  getMockRuntimeProjection,
} from "./mock-runtime-adapter.js";

export { PROJECTION_DISCLAIMER } from "./runtime-contract.js";

type ProjectionSummary = {
  source: typeof DARK_FACTORY_PROJECTION_SOURCE;
  truthSource: typeof DARK_FACTORY_TRUTH_SOURCE;
  authoritative: typeof PROJECTION_AUTHORITATIVE;
  disclaimer: typeof PROJECTION_DISCLAIMER;
  journalCursor: ReturnType<typeof getMockJournalCursor>;
  lastSequenceNo: number;
  projectionStatus: ReturnType<typeof getMockRuntimeProjection>["projectionStatus"];
  callbackReceiptId: string;
  staleReason: string | null;
  degradedReason: string | null;
  blockedReason: string | null;
  projection: ReturnType<typeof getMockRuntimeProjection>;
  providerHealth: ReturnType<typeof getMockProviderHealth>;
  runAttemptMetadata: ReturnType<typeof getMockRunAttemptMetadata>;
};

function buildSummary(issueId: string): ProjectionSummary {
  const projection = getMockRuntimeProjection(issueId);
  return {
    source: DARK_FACTORY_PROJECTION_SOURCE,
    truthSource: DARK_FACTORY_TRUTH_SOURCE,
    authoritative: PROJECTION_AUTHORITATIVE,
    disclaimer: PROJECTION_DISCLAIMER,
    journalCursor: projection.journalCursorMetadata,
    lastSequenceNo: projection.lastSequenceNo,
    projectionStatus: projection.projectionStatus,
    callbackReceiptId: projection.callbackReceiptId,
    staleReason: projection.staleReason,
    degradedReason: projection.degradedReason,
    blockedReason: projection.blockedReason,
    projection,
    providerHealth: getMockProviderHealth(issueId),
    runAttemptMetadata: getMockRunAttemptMetadata(issueId),
  };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordBody(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function idempotencyKeyFrom(input: PluginApiRequestInput, body: Record<string, unknown> | null): string | null {
  return stringField(body?.idempotencyKey) ?? stringField(input.headers?.["idempotency-key"]) ?? stringField(input.headers?.["Idempotency-Key"]);
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
      return createMockRehydrateRequest(issueId, {
        reason: stringField(params.reason),
        idempotencyKey: stringField(params.idempotencyKey),
      });
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
      return { status: 200, body: getMockRuntimeProjection(issueId) };
    }

    if (input.routeKey === "journal-cursor") {
      const projection = getMockRuntimeProjection(issueId);
      return {
        status: 200,
        body: {
          ...projection,
          cursor: projection.journalCursorMetadata,
        },
      };
    }

    if (input.routeKey === "provider-health") {
      const projection = getMockRuntimeProjection(issueId);
      const providerHealth = getMockProviderHealth(issueId);
      return {
        status: 200,
        body: {
          ...projection,
          observationSource: RUNTIME_OBSERVATION_SOURCE,
          providerRole: providerHealth.providerRole,
          modelRole: providerHealth.modelRole,
          modelSelection: providerHealth.modelSelection,
          breakerState: providerHealth.breakerState,
          providerState: providerHealth.providerState,
          degraded: providerHealth.degraded,
          blocked: providerHealth.blocked,
          fallbackTriggered: providerHealth.fallbackTriggered,
          providerHealth,
          runAttemptMetadata: getMockRunAttemptMetadata(issueId),
        },
      };
    }

    if (input.routeKey === "runtime-capability-snapshot") {
      return {
        status: 200,
        body: buildSummary(issueId),
      };
    }

    if (input.routeKey === "rehydrate-request") {
      const body = recordBody(input.body);
      return {
        status: 202,
        body: createMockRehydrateRequest(issueId, {
          reason: stringField(body?.reason),
          idempotencyKey: idempotencyKeyFrom(input, body),
        }),
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
      message: "Dark Factory deterministic mock runtime adapter is running in projection-only mode",
      details: {
        source: DARK_FACTORY_PROJECTION_SOURCE,
        truthSource: DARK_FACTORY_TRUTH_SOURCE,
        authoritative: PROJECTION_AUTHORITATIVE,
        observationSource: RUNTIME_OBSERVATION_SOURCE,
      },
    };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
