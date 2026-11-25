import type { ActorInfo } from "./types.js";
import type { Db } from "@paperclipai/db";
import { toolAccessAuditEvents } from "@paperclipai/db";
import { recordToolRuntimeAuditWriteFailure } from "../tool-runtime-metrics.js";

export function createToolAccessAudit(db: Db) {
  async function audit(input: {
    companyId: string;
    connectionId?: string | null;
    catalogEntryId?: string | null;
    action: string;
    outcome: "success" | "failure";
    reasonCode?: string | null;
    details?: Record<string, unknown>;
    actor?: ActorInfo;
  }) {
    try {
      await db.insert(toolAccessAuditEvents).values({
        companyId: input.companyId,
        connectionId: input.connectionId ?? null,
        catalogEntryId: input.catalogEntryId ?? null,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? null,
        action: input.action,
        outcome: input.outcome,
        reasonCode: input.reasonCode ?? null,
        details: input.details ?? {},
      });
    } catch (error) {
      await recordToolRuntimeAuditWriteFailure(db, input.companyId);
      throw error;
    }
  }
  return audit;
}

export type ToolAccessAudit = ReturnType<typeof createToolAccessAudit>;
