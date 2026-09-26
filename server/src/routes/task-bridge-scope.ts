import type { Request } from "express";
import type { TaskBridgeAgentKeyScope } from "@paperclipai/shared";

/**
 * Key-scope classifiers shared across routes that must enforce the task_bridge
 * and skill_test fences. Centralised here so route handlers and their tests
 * cannot drift apart on what "inside the fence" means.
 *
 * task_bridge key: approved for one or more projects; may create issues inside
 * that set and read back its own assignments. Refused on every company-wide
 * enumeration surface. The refusal is by key kind, so no query filter converts
 * it into an allow.
 *
 * skill_test key: issued per run, scoped to a single issue id. Not a
 * company-wide key that merely lacks a project fence — it is a single-issue
 * token that must never reach a list endpoint.
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

export function isSkillTestKeyActor(req: Request) {
  return (
    req.actor.type === "agent" &&
    req.actor.source === "agent_key" &&
    req.actor.keyScope?.kind === "skill_test"
  );
}

/**
 * Returns the single issue id that a skill_test key is scoped to, or null if
 * the actor is not a skill_test key. Useful for 403 error details.
 */
export function skillTestKeyScopedIssueId(req: Request): string | null {
  if (!isSkillTestKeyActor(req)) return null;
  const scope = req.actor.keyScope;
  return scope?.kind === "skill_test" ? scope.issueId : null;
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
