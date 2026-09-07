import { eq } from "drizzle-orm";
import { runIdentityContexts, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import { buildGitAuthInvocation, resolveManagedGitHubCredential } from "./git-credentials.js";
import { secretService } from "./secrets.js";

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  source?: "personal" | "dedicated";
  login?: string;
  reason?: string;
};

/** No company secrets or ambient credentials are consulted by this path. */
export async function resolveGitHubOperationCredentials(db: Db, input: {
  companyId: string; agentId: string; runId: string;
}) {
  const { run, context } = await captureRunIdentity(db, input);
  if (!context) throw forbidden("This run predates managed GitHub credentials");
  let summary: GitHubCredentialSummary;
  let env: Record<string, string> = {};
  try {
    const resolved = await resolveManagedGitHubCredential(db, secretService(db), input.companyId, {
      agentId: input.agentId, heartbeatRunId: input.runId,
      allowStandingDelegation: false,
      responsibleUserId: context?.cause === "company_default" ? null : context?.responsibleUserId ?? null,
      issueId: typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null,
    });
    if (resolved.credential) {
      summary = { status: "available", source: resolved.credential.identitySource, login: resolved.credential.githubIdentity?.login };
      env = buildGitAuthInvocation(resolved.credential).env;
    } else {
      summary = { status: resolved.configured ? "unavailable" : "absent", source: resolved.identitySource ?? "personal", reason: resolved.error ?? "No GitHub identity connected" };
    }
  } catch {
    // Provider/secret errors can contain sensitive response bodies. Never persist them.
    summary = { status: "unavailable", reason: "GitHub credentials are temporarily unavailable" };
  }
  if (context) await db.update(runIdentityContexts).set({ github: summary }).where(eq(runIdentityContexts.id, context.id));
  return { identityContextId: context?.id ?? null, revision: context?.revision ?? null, ...summary, env };
}
