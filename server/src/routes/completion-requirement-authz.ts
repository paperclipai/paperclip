import type { Request } from "express";
import { forbidden } from "../errors.js";

/**
 * The completion requirement is the board's contract with the agent: it decides
 * whether a task can reach `done` on a claim alone or needs provider evidence.
 * An agent must not be able to choose, relax or clear that contract.
 *
 * Board writes, system writes and internal callers are unchanged; only agent
 * keys are refused. The update path also enforces this in
 * `assertCompletionRequirementMutation`, which compares the previous value.
 */
export function assertNoAgentCompletionRequirementSupply(
  req: Request,
  value: unknown,
  path: string,
) {
  if (req.actor.type !== "agent") return;
  if (value === undefined || value === null) return;
  throw forbidden(`Agent keys cannot set ${path}.`, {
    code: "completion_requirement_protected",
  });
}
