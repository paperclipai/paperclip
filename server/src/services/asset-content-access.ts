import { and, eq } from "drizzle-orm";
import { assets, heartbeatRuns, issues, issueAttachments, runnerApiResponseReservations, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { canActorReadHeartbeatRun } from "./heartbeat-run-privacy.js";

type Asset = Pick<typeof assets.$inferSelect, "id" | "companyId" | "objectKey" | "createdByAgentId" | "createdByUserId">;

function namespace(asset: Asset) {
  const parts = asset.objectKey.split("/");
  return parts[1] === "assets" ? parts[2] : parts[1];
}

export async function isRunnerApiResponseAsset(db: Pick<Db, "select">, asset: Asset): Promise<boolean> {
  if (namespace(asset) === "runner-api") return true;
  return !!(await db.select({ id: runnerApiResponseReservations.id }).from(runnerApiResponseReservations)
    .where(and(eq(runnerApiResponseReservations.assetId, asset.id), eq(runnerApiResponseReservations.companyId, asset.companyId))).limit(1))[0];
}

export async function canActorReadAssetContent(db: Db, actor: AuthorizationActor, asset: Asset): Promise<boolean> {
  const access = authorizationService(db);
  if (actor.type === "agent") {
    if (actor.companyId !== asset.companyId) return false;
  } else if (actor.type !== "board" || !(await access.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId: asset.companyId } })).allowed) return false;
  const parts = asset.objectKey.split("/");
  const isDraft = parts[1] === "assets" && parts[2] === "issues" && parts[3] === "drafts";
  const sourceIssueId = parts[1] === "assets" ? parts[3] : parts[2];
  if (namespace(asset) === "issues" && !isDraft) {
    if (!sourceIssueId || !isUuidLike(sourceIssueId)) return false;
    const [issue] = await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, asset.companyId))).limit(1);
    if (!issue || !(await access.decide({ actor, action: "issue:read", resource: {
      type: "issue", companyId: asset.companyId, issueId: sourceIssueId,
    } })).allowed) return false;
  }
  const captures = await db.select({ run: heartbeatRuns }).from(runnerApiResponseReservations)
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, runnerApiResponseReservations.runId))
    .where(and(eq(runnerApiResponseReservations.assetId, asset.id), eq(runnerApiResponseReservations.companyId, asset.companyId)));
  if (namespace(asset) === "runner-api" && !captures.length) return false;
  for (const { run } of captures) {
    const owns = run && (actor.type === "agent"
      ? actor.agentId === run.agentId && (!run.responsibleUserId || actor.onBehalfOfUserId === run.responsibleUserId)
      : actor.type === "board" && (actor.source === "local_implicit" || actor.isInstanceAdmin
        || (Boolean(actor.userId) && actor.userId === run.responsibleUserId)));
    if (!owns || !run || !(await canActorReadHeartbeatRun(db, access, actor, run))) return false;
  }
  const attachments = await db.select({ issueId: issueAttachments.issueId }).from(issueAttachments)
    .where(and(eq(issueAttachments.assetId, asset.id), eq(issueAttachments.companyId, asset.companyId)));
  if (isDraft && !attachments.length && !(actor.type === "board"
    ? actor.source === "local_implicit" || actor.isInstanceAdmin || actor.userId === asset.createdByUserId
    : actor.type === "agent" && actor.agentId === asset.createdByAgentId
      && (!asset.createdByUserId || actor.onBehalfOfUserId === asset.createdByUserId))) return false;
  for (const attachment of attachments) {
    if (!(await access.decide({ actor, action: "issue:read", resource: {
      type: "issue", companyId: asset.companyId, issueId: attachment.issueId,
    } })).allowed) return false;
  }
  return true;
}
