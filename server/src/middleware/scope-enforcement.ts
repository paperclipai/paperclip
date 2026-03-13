/**
 * Scope enforcement middleware for agent identity.
 *
 * Enforces two rules:
 * 1. An agent can only perform actions within its declared scopes.
 * 2. When an agent creates a child agent, the child's scopes must be
 *    a strict subset of the parent's scopes (scope narrowing, StrongDM use case #4).
 */

import type { Request, Response, NextFunction } from "express";
import type { LocalAgentJwtClaims } from "../agent-auth-jwt.js";

/**
 * Validate that requiredScopes are all present in the agent's token scopes.
 * Returns null if valid, or an error message string if not.
 */
export function validateScopes(
  agentScopes: string[] | undefined,
  requiredScopes: string[],
): string | null {
  if (!requiredScopes.length) return null;
  if (!agentScopes || !agentScopes.length) {
    return `Agent has no scopes. Required: ${requiredScopes.join(", ")}`;
  }

  const scopeSet = new Set(agentScopes);
  const missing = requiredScopes.filter((s) => !scopeSet.has(s));
  if (missing.length) {
    return `Agent missing required scopes: ${missing.join(", ")}`;
  }
  return null;
}

/**
 * Validate that child scopes are a subset of parent scopes.
 * Used when an agent creates (spawns) a child agent.
 */
export function validateScopeNarrowing(
  parentScopes: string[],
  childScopes: string[],
): string | null {
  if (!childScopes.length) return null;

  const parentSet = new Set(parentScopes);
  const escalated = childScopes.filter((s) => !parentSet.has(s));
  if (escalated.length) {
    return `Scope escalation blocked. Child requested scopes not in parent: ${escalated.join(", ")}`;
  }
  return null;
}

/**
 * Validate scope depth. An agent can only spawn children up to maxScopeDepth levels deep.
 */
export function validateScopeDepth(
  parentDepth: number,
  maxDepth: number,
): string | null {
  if (maxDepth <= 0) return null; // 0 means no depth limit
  if (parentDepth >= maxDepth) {
    return `Maximum delegation depth (${maxDepth}) reached. Cannot spawn more child agents.`;
  }
  return null;
}

/**
 * Express middleware factory. Pass the required scopes for a route.
 * Reads agent claims from req.agentClaims (set by auth middleware).
 *
 * Usage:
 *   router.post("/some-action", requireScopes(["patient_lookup"]), handler);
 */
export function requireScopes(...requiredScopes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const claims = (req as unknown as { agentClaims?: LocalAgentJwtClaims }).agentClaims;

    if (!claims) {
      // No agent claims means this is a board/user request, not scope-restricted
      return next();
    }

    const error = validateScopes(claims.scopes, requiredScopes);
    if (error) {
      res.status(403).json({ error, code: "SCOPE_VIOLATION" });
      return;
    }

    next();
  };
}

/**
 * Compute the PHI access level required for a given set of scopes.
 * Any scope that touches patient data requires at least "read" level.
 */
const PHI_READ_SCOPES = new Set([
  "patient_lookup",
  "patient_identity_resolution",
  "request_classification",
  "urgency_assessment",
  "task_monitoring",
]);

const PHI_WRITE_SCOPES = new Set([
  "prescription_write",
  "chart_write",
  "order_create",
]);

export function requiredPhiLevel(scopes: string[]): "none" | "read" | "read_write" {
  if (scopes.some((s) => PHI_WRITE_SCOPES.has(s))) return "read_write";
  if (scopes.some((s) => PHI_READ_SCOPES.has(s))) return "read";
  return "none";
}
