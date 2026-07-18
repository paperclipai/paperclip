import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  executionWorkspaces,
  fleetPatrolAudit,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";

export const FLEET_PATROL_AGENT_ID = "efe05cc3-1470-41c4-ad2a-d69912f56511";
export const FLEET_PATROL_STALE_LOCK_MS = 15 * 60 * 1000;

export type FleetPatrolOperation =
  | "clear_agent_error"
  | "release_issue_lock"
  | "reset_workspace_pin";

export interface FleetPatrolActor {
  agentId: string;
  companyId: string;
  runId: string;
  apiKeyId: string | null;
  credentialId: string;
  source: string;
}

export interface FleetPatrolRequest {
  operation: FleetPatrolOperation;
  targetId: string;
}

export interface FleetPatrolResult {
  allowed: boolean;
  reasonCode: string;
  status: 200 | 403 | 409 | 422;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

function targetType(operation: string) {
  return operation === "clear_agent_error" ? "agent" : "issue";
}

function auditValues(
  actor: FleetPatrolActor,
  input: { operation: string; targetId: string },
  result: FleetPatrolResult,
) {
  return {
    companyId: actor.companyId,
    authenticatedAgentId: actor.agentId,
    authenticatedRunId: actor.runId,
    apiKeyId: actor.apiKeyId,
    credentialId: actor.credentialId,
    operation: input.operation,
    targetType: targetType(input.operation),
    targetId: input.targetId,
    outcome: result.allowed ? "allowed" : "denied",
    reasonCode: result.reasonCode,
    before: result.before ?? null,
    after: result.after ?? null,
  };
}

export async function auditMalformedFleetPatrolRequest(
  db: Db,
  actor: FleetPatrolActor,
  input: { operation: string; targetId: string },
) {
  const result: FleetPatrolResult = {
    allowed: false,
    reasonCode: "schema_invalid",
    status: 422,
  };
  await db.insert(fleetPatrolAudit).values(auditValues(actor, input, result));
}

async function validateOrgChain(tx: any, target: typeof agents.$inferSelect) {
  const seen = new Set<string>([target.id]);
  let managerId = target.reportsTo;
  while (managerId) {
    if (seen.has(managerId)) return false;
    seen.add(managerId);
    const manager = await tx
      .select({ id: agents.id, companyId: agents.companyId, reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.id, managerId))
      .then((rows: Array<{ id: string; companyId: string; reportsTo: string | null }>) => rows[0] ?? null);
    if (!manager || manager.companyId !== target.companyId) return false;
    managerId = manager.reportsTo;
  }
  return true;
}

export function fleetPatrolRemediationService(db: Db) {
  return {
    execute: async (
      actor: FleetPatrolActor,
      input: FleetPatrolRequest,
      now = new Date(),
    ): Promise<FleetPatrolResult> =>
      db.transaction(async (tx) => {
        const finish = async (result: FleetPatrolResult) => {
          await tx.insert(fleetPatrolAudit).values(auditValues(actor, input, result));
          return result;
        };

        if (process.env.PAPERCLIP_FLEET_PATROL_REMEDIATION_ENABLED !== "true") {
          return finish({ allowed: false, reasonCode: "capability_disabled", status: 403 });
        }
        if (actor.source !== "agent_jwt" || actor.agentId !== FLEET_PATROL_AGENT_ID) {
          return finish({ allowed: false, reasonCode: "principal_denied", status: 403 });
        }

        const signedRun = await tx
          .select({
            id: heartbeatRuns.id,
            companyId: heartbeatRuns.companyId,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, actor.runId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !signedRun
          || signedRun.companyId !== actor.companyId
          || signedRun.agentId !== actor.agentId
          || signedRun.status !== "running"
        ) {
          return finish({ allowed: false, reasonCode: "signed_run_not_running", status: 403 });
        }

        if (input.operation === "clear_agent_error") {
          const target = await tx
            .select()
            .from(agents)
            .where(and(eq(agents.id, input.targetId), eq(agents.companyId, actor.companyId)))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!target) return finish({ allowed: false, reasonCode: "target_not_found", status: 403 });
          if (target.status !== "error") {
            return finish({ allowed: false, reasonCode: "agent_not_remediable", status: 409 });
          }
          if (!(await validateOrgChain(tx, target))) {
            return finish({ allowed: false, reasonCode: "invalid_org_chain", status: 409 });
          }
          const latestRun = await tx
            .select({
              status: heartbeatRuns.status,
              errorCode: heartbeatRuns.errorCode,
            })
            .from(heartbeatRuns)
            .where(and(
              eq(heartbeatRuns.companyId, actor.companyId),
              eq(heartbeatRuns.agentId, target.id),
            ))
            .orderBy(desc(heartbeatRuns.createdAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (latestRun?.status !== "failed" || latestRun.errorCode !== "process_lost") {
            return finish({ allowed: false, reasonCode: "error_cause_not_allowed", status: 409 });
          }

          const before = {
            status: target.status,
            pauseReason: target.pauseReason,
            pausedAt: target.pausedAt?.toISOString() ?? null,
            errorReasonPresent: Boolean(target.errorReason),
          };
          await tx
            .update(agents)
            .set({
              status: "idle",
              pauseReason: null,
              pausedAt: null,
              errorReason: null,
              updatedAt: now,
            })
            .where(and(
              eq(agents.id, target.id),
              eq(agents.companyId, actor.companyId),
              eq(agents.status, "error"),
            ));
          return finish({
            allowed: true,
            reasonCode: "process_lost_error_cleared",
            status: 200,
            before,
            after: {
              status: "idle",
              pauseReason: null,
              pausedAt: null,
              errorReasonPresent: false,
            },
          });
        }

        const issue = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.id, input.targetId), eq(issues.companyId, actor.companyId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!issue) return finish({ allowed: false, reasonCode: "target_not_found", status: 403 });

        const referencedRunIds = Array.from(
          new Set([issue.checkoutRunId, issue.executionRunId].filter((id): id is string => Boolean(id))),
        );
        const referencedRuns = referencedRunIds.length
          ? await tx
            .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, companyId: heartbeatRuns.companyId })
            .from(heartbeatRuns)
            .where(inArray(heartbeatRuns.id, referencedRunIds))
            .for("update")
          : [];
        const runById = new Map(referencedRuns.map((run) => [run.id, run]));
        const hasUnknownOwner = referencedRunIds.some((id) => !runById.has(id));
        const hasUnknownOwnerStatus = referencedRuns.some(
          (run) => !TERMINAL_RUN_STATUSES.has(run.status) && !ACTIVE_RUN_STATUSES.has(run.status),
        );
        const hasActiveOwner = referencedRuns.some(
          (run) => run.companyId !== actor.companyId || ACTIVE_RUN_STATUSES.has(run.status),
        );

        if (input.operation === "release_issue_lock") {
          if (!referencedRunIds.length || !issue.executionLockedAt) {
            return finish({ allowed: false, reasonCode: "lock_missing", status: 409 });
          }
          if (hasUnknownOwner) {
            return finish({ allowed: false, reasonCode: "lock_owner_unknown", status: 409 });
          }
          if (hasUnknownOwnerStatus) {
            return finish({ allowed: false, reasonCode: "lock_owner_unknown_status", status: 409 });
          }
          if (hasActiveOwner) {
            return finish({ allowed: false, reasonCode: "lock_owner_active", status: 409 });
          }
          if (now.getTime() - issue.executionLockedAt.getTime() < FLEET_PATROL_STALE_LOCK_MS) {
            return finish({ allowed: false, reasonCode: "lock_not_stale", status: 409 });
          }
          const activeRecovery = await tx
            .select({ id: issueRecoveryActions.id })
            .from(issueRecoveryActions)
            .where(and(
              eq(issueRecoveryActions.companyId, actor.companyId),
              eq(issueRecoveryActions.sourceIssueId, issue.id),
              inArray(issueRecoveryActions.status, ["active", "escalated"]),
            ))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (activeRecovery) {
            return finish({ allowed: false, reasonCode: "recovery_owner_active", status: 409 });
          }

          const before = {
            checkoutRunId: issue.checkoutRunId,
            executionRunId: issue.executionRunId,
            executionAgentNameKey: issue.executionAgentNameKey,
            executionLockedAt: issue.executionLockedAt.toISOString(),
          };
          await tx
            .update(issues)
            .set({
              checkoutRunId: null,
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: now,
            })
            .where(and(
              eq(issues.id, issue.id),
              eq(issues.companyId, actor.companyId),
              issue.checkoutRunId
                ? eq(issues.checkoutRunId, issue.checkoutRunId)
                : isNull(issues.checkoutRunId),
              issue.executionRunId
                ? eq(issues.executionRunId, issue.executionRunId)
                : isNull(issues.executionRunId),
            ));
          return finish({
            allowed: true,
            reasonCode: "terminal_stale_lock_released",
            status: 200,
            before,
            after: {
              checkoutRunId: null,
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
            },
          });
        }

        if (issue.executionWorkspacePreference !== "reuse_existing") {
          return finish({ allowed: false, reasonCode: "workspace_preference_not_reusable", status: 409 });
        }
        if (hasUnknownOwner) {
          return finish({ allowed: false, reasonCode: "issue_run_unknown", status: 409 });
        }
        if (hasUnknownOwnerStatus) {
          return finish({ allowed: false, reasonCode: "issue_run_unknown_status", status: 409 });
        }
        if (hasActiveOwner) {
          return finish({ allowed: false, reasonCode: "issue_run_active", status: 409 });
        }
        const failedRun = issue.executionRunId ? runById.get(issue.executionRunId) : null;
        const failedRunDetails = issue.executionRunId
          ? await tx
            .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;
        if (!failedRun || failedRunDetails?.status !== "failed" || failedRunDetails.errorCode !== "workspace_validation_failed") {
          return finish({ allowed: false, reasonCode: "workspace_failure_not_proven", status: 409 });
        }
        const workspace = issue.executionWorkspaceId
          ? await tx
            .select({
              id: executionWorkspaces.id,
              companyId: executionWorkspaces.companyId,
              projectId: executionWorkspaces.projectId,
              status: executionWorkspaces.status,
            })
            .from(executionWorkspaces)
            .where(eq(executionWorkspaces.id, issue.executionWorkspaceId))
            .then((rows) => rows[0] ?? null)
          : null;
        const invalidWorkspace = !workspace
          || workspace.companyId !== actor.companyId
          || workspace.status !== "active"
          || workspace.projectId !== issue.projectId;
        if (!invalidWorkspace) {
          return finish({ allowed: false, reasonCode: "workspace_still_valid", status: 409 });
        }

        const before = {
          executionWorkspacePreference: issue.executionWorkspacePreference,
          executionWorkspaceId: issue.executionWorkspaceId,
        };
        await tx
          .update(issues)
          .set({
            executionWorkspacePreference: "agent_default",
            executionWorkspaceId: null,
            updatedAt: now,
          })
          .where(and(
            eq(issues.id, issue.id),
            eq(issues.companyId, actor.companyId),
            eq(issues.executionWorkspacePreference, "reuse_existing"),
            ...(issue.executionWorkspaceId
              ? [eq(issues.executionWorkspaceId, issue.executionWorkspaceId)]
              : []),
          ));
        return finish({
          allowed: true,
          reasonCode: "invalid_workspace_pin_reset",
          status: 200,
          before,
          after: {
            executionWorkspacePreference: "agent_default",
            executionWorkspaceId: null,
          },
        });
      }),
  };
}
