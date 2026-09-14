import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { captureRunIdentity } from "../run-identity.js";
import { loadResponsibleUserMemberships } from "../../middleware/auth.js";
import { runtimeServiceToolMutates } from "./tools.js";

/** A transport binding is supplied by the server, never by tool arguments. */
export async function resolveRuntimeServiceToolActor(db: Db, binding: {
  companyId: string; agentId: string; runId: string;
}, tool: string): Promise<{ req: Request; workMode: string }> {
  const { run } = await captureRunIdentity(db, binding);
  const issueId = run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
  const [task] = typeof issueId === "string" ? await db.select({ id: issues.id, workMode: issues.workMode })
    .from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, binding.companyId))) : [];
  const req = {
    method: runtimeServiceToolMutates(tool) ? "POST" : "GET",
    actor: {
      type: "agent", source: "agent_jwt", companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId,
      onBehalfOfUserId: run.responsibleUserId,
      identityContextId: run.activeIdentityContextId,
      onBehalfOfMemberships: await loadResponsibleUserMemberships(db, { companyId: binding.companyId, userId: run.responsibleUserId }),
      keyScope: task?.workMode === "skill_test" ? { kind: "skill_test", issueId: task.id } : { kind: "standard" },
    },
  } as Request;
  return { req, workMode: task?.workMode ?? "standard" };
}
