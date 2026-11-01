import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { HarnessRuntimeRequestResolution } from "../../vendor/paperclip-runner/index.js";
import { accessService } from "../access.js";
import { loadConfig } from "../../config.js";
import { conflict } from "../../errors.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { activeNativeExecutionRunIds, subscribeActiveNativeExecutions } from "./native-active-runs.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { assertNativeRuntimeRequestResolverAuthorized, NativeRuntimeRequestResolutionAuthorizationError,
  readPendingNativeRuntimeRequest, type NativeRuntimeRequestResolver, type PendingNativeRuntimeRequest } from "./runtime-request-resolution-authority.js";

type ResponseCommand = {
  commandId: string;
  request: PendingNativeRuntimeRequest;
  actor: NativeRuntimeRequestResolver;
  localImplicit: boolean;
  resolution: HarnessRuntimeRequestResolution;
  fingerprint: string;
  state: "pending" | "queued" | "obsolete" | "denied";
};
function commands(result: Record<string, unknown> | null): Record<string, ResponseCommand> {
  const value = result?.nativeRuntimeResponses;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, ResponseCommand> : {};
}
const requestKey = (id: string) => createHash("sha256").update(id).digest("hex");

/** The run owns these commands just as it owns Stop intent. HTTP admission is
 * durable; the controller lease and canonical request lifecycle own dispatch. */
export async function enqueueNativeRuntimeResponse(db: Db, input: {
  request: PendingNativeRuntimeRequest;
  actor: NativeRuntimeRequestResolver;
  localImplicit: boolean;
  resolution: HarnessRuntimeRequestResolution;
}) {
  assertNativeRuntimeRequestResolverAuthorized(input.request, input.actor);
  const key = requestKey(input.request.requestId);
  const fingerprint = JSON.stringify({ request: input.request, userId: input.actor.userId, resolution: input.resolution });
  return db.transaction(async tx => {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeRuntimeResponses);
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.request.runId), eq(heartbeatRuns.companyId, input.request.companyId),
    )).for("update").limit(1);
    if (!run || run.runtimeMode !== "native" || run.status !== "running") throw conflict("This runner session is no longer accepting runtime responses.");
    const existing = commands(run.resultJson);
    const prior = existing[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw conflict("A different response was already submitted for this runtime request.");
      if (prior.state === "denied" || prior.state === "obsolete") throw conflict("This runtime request is no longer actionable.");
      return { commandId: prior.commandId };
    }
    const pending = await readPendingNativeRuntimeRequest(tx as unknown as Db, input.request);
    if (!pending || pending.turnId !== input.request.turnId || pending.requestKind !== input.request.requestKind) {
      throw conflict("This runtime request is stale or is no longer pending.");
    }
    assertNativeRuntimeRequestResolverAuthorized(pending, input.actor);
    const command: ResponseCommand = { ...input, request: pending, commandId: `native-runtime-response:${randomUUID()}`, fingerprint, state: "pending" };
    await tx.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, nativeRuntimeResponses: { ...existing, [key]: command } },
      updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    return { commandId: command.commandId };
  });
}

/** Recheck access at consumption, including revocation during controller
 * replacement. Only the configured local-trusted operator bypasses membership. */
async function authorize(db: Db, command: ResponseCommand) {
  const pending = await readPendingNativeRuntimeRequest(db, command.request);
  if (!pending || pending.turnId !== command.request.turnId || pending.requestKind !== command.request.requestKind) {
    throw new RuntimeResponseObsoleteError();
  }
  const access = accessService(db);
  const local = command.localImplicit && loadConfig().deploymentMode === "local_trusted";
  const admin = local || await access.isInstanceAdmin(command.actor.userId);
  if (!local) {
    const membership = await access.getMembership(command.request.companyId, "user", command.actor.userId);
    if (membership?.status !== "active" || (!admin && membership.membershipRole === "viewer")) {
      throw new NativeRuntimeRequestResolutionAuthorizationError("native_runtime_request_resolver_denied");
    }
  }
  assertNativeRuntimeRequestResolverAuthorized(pending, { ...command.actor, isInstanceAdmin: admin });
  return { pending, actor: { ...command.actor, isInstanceAdmin: admin } };
}
class RuntimeResponseObsoleteError extends Error {}

export function registerNativeRuntimeResponseDelivery(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>) {
  const worker = coordinator.register(DELIVERY_QUEUES.nativeRuntimeResponses, {
    retryMs: 1000, runDuringDrain: true,
    async run(signal) {
      const ids = [...activeNativeExecutionRunIds];
      if (!ids.length) return;
      const identity = await currentNativeControllerIdentity();
      const rows = await db.select({ id: heartbeatRuns.id, result: heartbeatRuns.resultJson }).from(heartbeatRuns)
        .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id)).where(and(
          inArray(heartbeatRuns.id, ids), eq(nativeRunFinalizations.controllerBootId, identity.bootId),
          gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`),
          sql`${heartbeatRuns.resultJson} ? 'nativeRuntimeResponses'`,
        ));
      for (const row of rows) for (const [key, command] of Object.entries(commands(row.result))) {
        signal.throwIfAborted();
        if (command.state !== "pending" || !activeNativeExecutionRunIds.has(row.id)) continue;
        let state: ResponseCommand["state"] = "queued";
        try {
          const { resolveNativeRuntimeRequest, NativeRuntimeRequestResolutionError } = await import("./native-session-executor.js");
          try {
            await resolveNativeRuntimeRequest({ runId: row.id, requestId: command.request.requestId,
              turnId: command.request.turnId, resolution: command.resolution, commandId: command.commandId,
              authorizeBeforeDispatch: async () => { await authorize(db, command); } });
          } catch (error) {
            if (error instanceof NativeRuntimeRequestResolutionError && error.code === "runtime_request_stale_turn") {
              throw new RuntimeResponseObsoleteError();
            }
            if (!(error instanceof NativeRuntimeRequestResolutionError)
              || !["native_session_not_active", "runtime_request_resolution_unsupported"].includes(error.code)) throw error;
            const { pending, actor } = await authorize(db, command);
            const { queueRunnerPrpRuntimeRequestResolution } = await import("../../realtime/runner-prp-ws.js");
            queueRunnerPrpRuntimeRequestResolution({ companyId: pending.companyId, runId: row.id,
              pendingRequest: pending, actor, resolution: command.resolution, commandId: command.commandId });
          }
        } catch (error) {
          if (error instanceof RuntimeResponseObsoleteError) state = "obsolete";
          else if (error instanceof NativeRuntimeRequestResolutionAuthorizationError) state = "denied";
          else throw error; // The concrete pending command remains retryable.
        }
        await db.transaction(async tx => {
          const [current] = await tx.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, row.id)).for("update").limit(1);
          const saved = commands(current?.result ?? null);
          if (saved[key]?.commandId !== command.commandId || saved[key]?.state !== "pending") return;
          await tx.update(heartbeatRuns).set({ resultJson: { ...current.result, nativeRuntimeResponses: {
            ...saved, [key]: { ...saved[key], state },
          } }, updatedAt: new Date() }).where(eq(heartbeatRuns.id, row.id));
        });
      }
    },
    hasPending: async () => false,
  });
  const unsubscribe = subscribeActiveNativeExecutions(worker.wake);
  return { ready: worker.ready, async stop() { unsubscribe(); await worker.stop(); } };
}
