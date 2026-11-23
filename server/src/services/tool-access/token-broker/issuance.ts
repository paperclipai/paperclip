import type { ToolAccessMutationDb } from "../types.js";
import type { Db } from "@paperclipai/db";
import { connectionTokenIssuances } from "@paperclipai/db";
import type { ConnectionTokenIssuanceOutcome, ConnectionTokenIssuancePath } from "@paperclipai/shared";
import { logActivity } from "../../activity-log.js";

import type { ToolAccessAudit } from "../audit.js";
export function createTokenIssuanceRecorder(db: Db, audit: ToolAccessAudit) {
  async function recordConnectionTokenIssuance(
    input: {
      companyId: string;
      applicationId: string | null;
      connectionId: string;
      agentId: string;
      runId: string | null;
      issueId: string | null;
      projectId: string | null;
      responsibleUserId: string | null;
      path: ConnectionTokenIssuancePath;
      requestedScope: string[];
      issuedScope: string[];
      ttlSeconds: number | null;
      expiresAt: Date | null;
      tokenHash: string | null;
      outcome: ConnectionTokenIssuanceOutcome;
      errorCode?: string | null;
      metadata?: Record<string, unknown>;
    },
    dbClient: ToolAccessMutationDb = db,
  ) {
    await dbClient.insert(connectionTokenIssuances).values({
      companyId: input.companyId,
      applicationId: input.applicationId,
      connectionId: input.connectionId,
      agentId: input.agentId,
      runId: input.runId,
      issueId: input.issueId,
      projectId: input.projectId,
      responsibleUserId: input.responsibleUserId,
      path: input.path,
      requestedScope: input.requestedScope,
      issuedScope: input.issuedScope,
      ttlSeconds: input.ttlSeconds,
      expiresAt: input.expiresAt,
      tokenHash: input.tokenHash,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      metadata: input.metadata ?? {},
    });
  }

  async function auditConnectionTokenIssuance(input: {
    companyId: string;
    connectionId: string;
    agentId: string;
    runId: string;
    path: ConnectionTokenIssuancePath;
    outcome: ConnectionTokenIssuanceOutcome;
    reasonCode?: string | null;
    details?: Record<string, unknown>;
  }) {
    const success = input.outcome === "success";
    await audit({
      companyId: input.companyId,
      connectionId: input.connectionId,
      action: success ? "connection_token.minted" : "connection_token.denied",
      outcome: success ? "success" : "failure",
      reasonCode: input.reasonCode ?? null,
      actor: { actorType: "agent", actorId: input.agentId },
      details: {
        path: input.path,
        outcome: input.outcome,
        runId: input.runId,
        ...(input.details ?? {}),
      },
    });
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      action: success ? "connection_token.minted" : "connection_token.denied",
      entityType: "tool_connection",
      entityId: input.connectionId,
      details: {
        path: input.path,
        outcome: input.outcome,
        reasonCode: input.reasonCode ?? null,
        ...(input.details ?? {}),
      },
    });
  }
  return { recordConnectionTokenIssuance, auditConnectionTokenIssuance };
}
