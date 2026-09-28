import { and, eq } from "drizzle-orm";
import { heartbeatRuns, runIdentityContexts, type Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { captureRunIdentity } from "../run-identity.js";
import type { XBinding } from "./service.js";

/** Follow accepted controller provenance, including restricted public guests.
 * An unrelated Board message or delegated task cannot inherit an X interaction. */
export async function xRunOrigin(db: Db, binding: XBinding) {
  const captured = await captureRunIdentity(db, binding);
  if (
    (captured.run.contextSnapshot?.issueId ??
      captured.run.contextSnapshot?.taskId) !== binding.issueId
  )
    throw forbidden("X tools require the current task binding");
  let origin = captured.context;
  const visited = new Set<string>();
  while (origin && !origin.messageId && origin.parentContextId) {
    if (visited.has(origin.id) || visited.size >= 100)
      throw forbidden("X source provenance is unavailable");
    visited.add(origin.id);
    const [parent] = await db
      .select()
      .from(runIdentityContexts)
      .where(
        and(
          eq(runIdentityContexts.id, origin.parentContextId),
          eq(runIdentityContexts.companyId, binding.companyId),
          eq(runIdentityContexts.status, "accepted"),
        ),
      );
    if (!parent || parent.responsibleUserId !== captured.run.responsibleUserId)
      throw forbidden("X requester changed");
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, parent.runId),
          eq(heartbeatRuns.companyId, binding.companyId),
          eq(heartbeatRuns.agentId, binding.agentId),
        ),
      );
    if (
      !run ||
      (run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) !==
        binding.issueId
    )
      throw forbidden("X tools cannot be inherited by another task");
    origin = parent;
  }
  return { ...captured, sourceMessageId: origin?.messageId ?? null };
}
