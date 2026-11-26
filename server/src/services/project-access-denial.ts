import { HttpError } from "../errors.js";

export const PROJECT_ACCESS_DENIED = "project_access_denied";

/** Carries a safe, typed setup failure without changing the authorization decision. */
export class ProjectAccessDeniedError extends HttpError {
  constructor(readonly projectId: string) {
    super(403, "Project is outside this low-trust boundary.");
  }
}
