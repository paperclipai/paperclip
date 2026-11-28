import { and, eq, sql, type Placeholder } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { requestRunIdentityFields } from "../services/run-identity.js";
import { preparedStatement } from "../services/prepared-statements.js";

type Bound<Value> = Value | Placeholder;
export type AgentRunAuthenticationBinding = { runId: Bound<string>; companyId: Bound<string>; agentId: Bound<string> };

export function agentRunAuthenticationQuery(db: Db, input: AgentRunAuthenticationBinding) {
  return db.select({
    activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
    responsibleUserId: heartbeatRuns.responsibleUserId,
    status: heartbeatRuns.status,
    resultJson: sql<Record<string, unknown>>`jsonb_build_object(
      'executionCancellation', jsonb_build_object(
        'state', ${heartbeatRuns.resultJson}->'executionCancellation'->'state'
      ),
      'freshContinuationSupersededAt', ${heartbeatRuns.resultJson}->'freshContinuationSupersededAt'
    )`,
    contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
      'conversationMode', ${heartbeatRuns.contextSnapshot}->'conversationMode'
    )`,
    ...requestRunIdentityFields,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
  ));
}

const agentRunAuthenticationStatement = preparedStatement(db => agentRunAuthenticationQuery(db, {
  runId: sql.placeholder("runId"),
  companyId: sql.placeholder("companyId"),
  agentId: sql.placeholder("agentId"),
}).prepare("agent_run_authentication"));

export function loadAgentRunAuthentication(db: Db, input: {
  runId: string;
  companyId: string;
  agentId: string;
}) {
  return agentRunAuthenticationStatement(db).execute(input);
}
