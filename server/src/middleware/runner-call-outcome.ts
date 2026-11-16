import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { RUNNER_API_CALL_HEADER } from "../services/native-runtime/runner-api-client.js";
import { persistActivity } from "../services/activity-log.js";
import { RUNNER_API_COMPLETED_ACTION } from "../services/recovery-effect-receipts.js";
import { logger } from "./logger.js";

const CALL_KEY = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function recordRunnerApiOutcome(db: Db, input: {
  companyId: string; agentId: string; runId: string; callKey: string; status: number;
}) {
  await persistActivity(db, { companyId: input.companyId, actorType: "agent", actorId: input.agentId,
    agentId: input.agentId, runId: input.runId, action: RUNNER_API_COMPLETED_ACTION,
    entityType: "heartbeat_run", entityId: input.runId, details: { callKey: input.callKey, status: input.status } });
}

export function runnerCallOutcomeMiddleware(db: Db): RequestHandler {
  return (req, res, next) => {
    const callKey = req.header(RUNNER_API_CALL_HEADER);
    const { type, source, agentId, companyId, runId } = req.actor ?? {};
    if (!callKey || !CALL_KEY.test(callKey) || READ_METHODS.has(req.method) || type !== "agent"
      || source !== "agent_jwt" || !agentId || !companyId || !runId || !RUN_ID.test(runId)) {
      next();
      return;
    }
    const end = res.end;
    let recorded = false;
    res.end = function (this: typeof res, ...args: unknown[]) {
      if (!recorded) {
        recorded = true;
        recordRunnerApiOutcome(db, { companyId, agentId, runId, callKey, status: res.statusCode })
          .catch((err) => logger.warn({ err, runId }, "Failed to record a runner API call outcome"));
      }
      return (end as (...endArgs: unknown[]) => typeof res).apply(this, args);
    } as typeof res.end;
    next();
  };
}
