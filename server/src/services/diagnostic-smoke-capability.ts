import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logActivity } from "./activity-log.js";
import {
  diagnosticSmokeCheckoutBlock,
} from "./diagnostic-smoke-capability-policy.js";

export {
  DIAGNOSTIC_SMOKE_CAPABILITY_WARNING,
  annotateDiagnosticSmokeSnapshot,
  diagnosticSmokeCheckoutBlock,
  isDiagnosticSmokeWake,
  readSnapshotTaskBinding,
} from "./diagnostic-smoke-capability-policy.js";

export async function findDiagnosticSmokeCheckoutBlock(
  db: Db,
  input: { companyId: string; runId: string; agentId: string },
): Promise<string | null> {
  const run = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!run) return null;
  return diagnosticSmokeCheckoutBlock(run.contextSnapshot);
}

export async function recordDiagnosticSmokeCheckoutRejection(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    issueId: string;
    actorId: string;
    agentApiKeyId?: string | null;
    warning: string;
  },
): Promise<void> {
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.actorId,
    agentId: input.agentId,
    runId: input.runId,
    agentApiKeyId: input.agentApiKeyId ?? null,
    action: "issue.unassigned_smoke_checkout_rejected",
    entityType: "issue",
    entityId: input.issueId,
    issueId: input.issueId,
    details: {
      code: "unassigned_smoke_checkout_rejected",
      capability: "diagnostics_only",
      warning: input.warning,
      durable: true,
    },
  });
  await appendHeartbeatRunEvent(db, {
    companyId: input.companyId,
    runId: input.runId,
    agentId: input.agentId,
    eventType: "lifecycle",
    level: "warn",
    message: input.warning,
    payload: {
      code: "unassigned_smoke_checkout_rejected",
      targetIssueId: input.issueId,
      capability: "diagnostics_only",
      durable: true,
    },
  });
}
