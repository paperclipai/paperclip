import type { Request } from "express";
import type { TaskBridgeAgentKeyScope } from "@paperclipai/shared";

/**
 * A `task_bridge` key is fenced at issue level: it may create inside its
 * approved projects/parents and read back the issues it created or owns, but it
 * is refused on every company-wide surface. The refusal is by key KIND, so
 * narrowing a company-wide filter never converts it into an allow.
 *
 * These helpers give the scoped list route one definition of that fence, so the
 * route and its tests cannot drift apart on what "inside the fence" means.
 */
export function isTaskBridgeKeyActor(req: Request) {
  return (
    req.actor.type === "agent" &&
    req.actor.source === "agent_key" &&
    req.actor.keyScope?.kind === "task_bridge"
  );
}

export function taskBridgeKeyScope(req: Request): TaskBridgeAgentKeyScope | null {
  return isTaskBridgeKeyActor(req)
    ? (req.actor.keyScope as TaskBridgeAgentKeyScope)
    : null;
}

/**
 * Flatten the singular + plural project boundary into one list. The scope
 * schema accepts both `projectId` and `projectIds`; a key may carry either.
 */
export function taskBridgeScopeProjectIds(
  scope: TaskBridgeAgentKeyScope,
): string[] {
  const ids = [
    ...(typeof scope.projectId === "string" ? [scope.projectId] : []),
    ...(Array.isArray(scope.projectIds) ? scope.projectIds : []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(ids)];
}

/**
 * The assignee half of the fence. An empty list is NOT "allow every agent" — it
 * means the key declared no assignee boundary, so the only assignee it can
 * enumerate is its own agent. Returning the caller's own agent id here keeps the
 * list route from silently widening a key that never named a peer.
 */
export function taskBridgeScopeAssigneeAgentIds(
  scope: TaskBridgeAgentKeyScope,
  actorAgentId: string,
): string[] {
  const declared = Array.isArray(scope.allowedAssigneeAgentIds)
    ? scope.allowedAssigneeAgentIds.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  return [...new Set([actorAgentId, ...declared])];
}
