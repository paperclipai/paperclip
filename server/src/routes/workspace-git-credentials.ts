import type { RunJwtService } from "../services/run-jwt.js";

export type IssueGitCredentialsResult =
  | { ok: true; username: string; password: string; expiresAt: string }
  | { ok: false; reason: "not_configured" | "denied" | "internal_error" };

export interface WorkspaceGitCredentialsDeps {
  runJwt: RunJwtService;
  issueGitCredentials: (input: {
    runId: string;
    companyId: string;
    repoUrl: string;
  }) => Promise<IssueGitCredentialsResult>;
}

export interface WorkspaceGitCredentialsRequest {
  headers: { authorization?: string };
  body: { repoUrl?: string };
}

export interface WorkspaceGitCredentialsResponse {
  status: number;
  body: Record<string, unknown>;
}

export function createWorkspaceGitCredentialsRoute(deps: WorkspaceGitCredentialsDeps) {
  return async (req: WorkspaceGitCredentialsRequest): Promise<WorkspaceGitCredentialsResponse> => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return { status: 401, body: { error: "missing_authorization" } };
    const v = deps.runJwt.verify(auth.slice(7));
    if (!v.ok) return { status: 401, body: { error: "invalid_jwt" } };
    if (typeof req.body.repoUrl !== "string" || req.body.repoUrl.length === 0) {
      return { status: 400, body: { error: "missing_repo_url" } };
    }
    const r = await deps.issueGitCredentials({
      runId: v.claims.runId,
      companyId: v.claims.companyId,
      repoUrl: req.body.repoUrl,
    });
    if (!r.ok) {
      const status = r.reason === "not_configured" ? 503 : r.reason === "denied" ? 403 : 500;
      return { status, body: { error: r.reason } };
    }
    return { status: 200, body: { username: r.username, password: r.password, expiresAt: r.expiresAt } };
  };
}
