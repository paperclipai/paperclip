import type { Request, Response, NextFunction } from "express";
import { withApiErrorDiscriminator } from "@paperclipai/shared";

/**
 * Adds the additive `ok: false` discriminator to error bodies (RBR-924).
 *
 * ## Why a res.json shim rather than editing each `res.status(...).json(...)`
 *
 * A single issue-write route reaches an error body through at least four
 * different exits:
 *
 *   - `getAccessibleResource` → 404 `{ error: "Issue not found" }`
 *   - `denyIssueWrite` → 403/409/422/429 from the shared denial contract
 *   - `requireAgentRunId` → 401 `{ error: "Agent run id required" }`
 *   - a thrown `HttpError` (`assertCompanyAccess`, validation) → `errorHandler`
 *
 * Editing every literal would mean touching dozens of call sites and would
 * still miss the next one somebody adds. Wrapping `res.json` for the duration
 * of the request catches all four exits — including the ones that leave the
 * route handler entirely and land in the global error handler — with one hook.
 *
 * ## Additive-only guarantees
 *
 * The shim only fires when the status is >= 400 *and* the body already carries
 * a non-empty top-level `error` string. Success bodies (2xx, arrays, the issue
 * and comment objects) pass through byte-identical, so no existing client
 * breaks and no envelope is restructured. See `withApiErrorDiscriminator`.
 */
export function apiErrorDiscriminator() {
  return function apiErrorDiscriminatorMiddleware(
    _req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const originalJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      // Status is read at send time, not at mount time: routes call
      // `res.status(403).json(...)`, so the code is only known here.
      if (res.statusCode >= 400) {
        return originalJson(withApiErrorDiscriminator(body));
      }
      return originalJson(body);
    }) as Response["json"];
    next();
  };
}
