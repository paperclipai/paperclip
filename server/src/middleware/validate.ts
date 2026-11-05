import type { Request, Response, NextFunction } from "express";
import { ZodError, type ZodIssue, type ZodSchema } from "zod";
import { unprocessable } from "../errors.js";

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body);
    next();
  };
}

// The issue create/update contract requires HTTP 422 (not the generic Zod 400)
// when a request pins an invalid executionWorkspaceSettings.workspaceStrategy
// .existingBranch: bad branch syntax, placement outside isolated_workspace +
// git_worktree, or combination with branchTemplate. All three semantic checks
// report this exact path suffix, including when an issue-creating route nests
// the settings (for example accepted-plan-decomposition children). Requests
// that also fail unrelated validation keep the long-standing 400.
const EXISTING_BRANCH_SETTINGS_PATH = [
  "executionWorkspaceSettings",
  "workspaceStrategy",
  "existingBranch",
] as const;

export function isExistingBranchSemanticsZodIssue(issue: Pick<ZodIssue, "path">): boolean {
  const pathOffset = issue.path.length - EXISTING_BRANCH_SETTINGS_PATH.length;
  return (
    pathOffset >= 0 &&
    EXISTING_BRANCH_SETTINGS_PATH.every((segment, index) => issue.path[pathOffset + index] === segment)
  );
}

export function validateIssueMutationBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
    } catch (err) {
      if (
        err instanceof ZodError &&
        err.issues.length > 0 &&
        err.issues.every(isExistingBranchSemanticsZodIssue)
      ) {
        // Same body shape as the generic Zod 400 response, so the
        // field-specific details are preserved verbatim.
        throw unprocessable("Validation error", err.issues);
      }
      throw err;
    }
    next();
  };
}
