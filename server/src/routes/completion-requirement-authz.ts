import type { Request } from "express";
import { forbidden } from "../errors.js";

const PROTECTED_CODE = "completion_requirement_protected";

/**
 * The completion requirement is the board's contract with the agent: it decides
 * whether a task can reach `done` on a claim alone or needs provider evidence.
 * An agent must not be able to choose, relax or clear that contract.
 *
 * Board writes, system writes and internal callers are unchanged; only agent
 * keys are refused.
 */
export function assertNoAgentCompletionRequirementSupply(
  req: Request,
  value: unknown,
  path: string,
) {
  if (req.actor.type !== "agent") return;
  if (value === undefined || value === null) return;
  throw forbidden(`Agent keys cannot set ${path}.`, { code: PROTECTED_CODE });
}

/**
 * Same rule for updates, where `null` is a meaningful payload: it clears the
 * requirement, so the presence of the key alone is what an agent may not send.
 */
export function assertNoAgentCompletionRequirementChange(
  req: Request,
  body: Record<string, unknown> | undefined,
  key: string,
  path: string,
) {
  if (req.actor.type !== "agent") return;
  if (!body || !Object.prototype.hasOwnProperty.call(body, key)) return;
  throw forbidden(`Agent keys cannot set ${path}.`, { code: PROTECTED_CODE });
}
