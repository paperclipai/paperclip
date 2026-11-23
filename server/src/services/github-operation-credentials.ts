import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  heartbeatRuns,
  runIdentityContexts,
  type Db,
} from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunCompletionIdentity, captureRunIdentity, type RunIdentityContext } from "./run-identity.js";
import {
  buildGitAuthInvocation,
  resolveManagedGitHubCredential,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";
import { allowsGitCredentialExport } from "./git-credential-export-policy.js";

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  source?: "personal" | "dedicated";
  login?: string;
  reason?: string;
  connectionId?: string;
  grantId?: string;
  authenticationMode?: "managed" | "host" | "anonymous";
};

type GitHubCredentialRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "nativeIssueId" | "contextSnapshot">;

async function saveGitHubSummary(
  db: Db,
  context: RunIdentityContext,
  summary: GitHubCredentialSummary,
) {
  if (isDeepStrictEqual(context.github, JSON.parse(JSON.stringify(summary)))) return;
  await db
    .update(runIdentityContexts)
    .set({ github: summary })
    .where(eq(runIdentityContexts.id, context.id));
}

/** No company secrets or ambient credentials are consulted by this path. */
export async function resolveGitHubOperationCredentials(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
  },
) {
  const { run, context } = await captureRunIdentity(db, input, { readScope: "github_credentials" });
  if (!context) throw forbidden("This run predates managed GitHub credentials");
  return resolveCapturedGitHubCredentials(db, run, context);
}

export async function resolveGitHubCompletionCredentials(
  db: Db,
  input: { companyId: string; issueId: string; runId: string },
) {
  const [source] = await db.select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.nativeIssueId, input.issueId))).limit(1);
  if (!source) throw forbidden("GitHub completion requires the bound task run");
  const { run, context } = await captureRunCompletionIdentity(db, { ...input, agentId: source.agentId });
  if (!run.activeIdentityContextId && !context) return { status: "absent" as const, env: {} as Record<string, string> };
  if (!context || context.companyId !== run.companyId || context.status !== "accepted") {
    throw forbidden("GitHub completion requires the run's accepted identity");
  }
  return resolveCapturedGitHubCredentials(db, run, context);
}

async function resolveCapturedGitHubCredentials(db: Db, run: GitHubCredentialRun, context: RunIdentityContext) {
  let summary: GitHubCredentialSummary;
  let env: Record<string, string> = {};
  // A sponsored guest's responsible person is an internal accountability field,
  // not authorization to export that person's (or a dedicated bot's) token.
  // Re-read every policy source for each operation, including a run's retained
  // boundary after task policy edits. Deny before touching the credential store.
  if (!(await allowsGitCredentialExport(db, run))) {
    summary = {
      status: "unavailable",
      reason:
        "GitHub credentials are not available to low-trust or unverified executions; use authorized read-only tools.",
    };
    await saveGitHubSummary(db, context, summary);
    return {
      identityContextId: context.id,
      revision: context.revision,
      ...summary,
      env,
    };
  }
  try {
    const resolved = await resolveManagedGitHubCredential(
      db,
      secretService(db),
      run.companyId,
      {
        agentId: run.agentId,
        heartbeatRunId: run.id,
        allowStandingDelegation: false,
        responsibleUserId:
          context?.cause === "company_default"
            ? null
            : (context?.responsibleUserId ?? null),
        issueId:
          typeof run.contextSnapshot?.issueId === "string"
            ? run.contextSnapshot.issueId
            : null,
      },
    );
    if (resolved.credential) {
      summary = {
        status: "available",
        source: resolved.credential.identitySource,
        login: resolved.credential.githubIdentity?.login,
        connectionId: resolved.credential.connectionId,
        grantId: resolved.credential.grantId,
        authenticationMode: "managed",
      };
      env = buildGitAuthInvocation(resolved.credential).env;
    } else {
      summary = {
        status: resolved.configured ? "unavailable" : "absent",
        source: resolved.identitySource ?? "personal",
        reason: resolved.error ?? "No GitHub identity connected",
      };
    }
  } catch {
    // Provider/secret errors can contain sensitive response bodies. Never persist them.
    summary = {
      status: "unavailable",
      reason: "GitHub credentials are temporarily unavailable",
    };
  }
  if (context) await saveGitHubSummary(db, context, summary);
  return {
    identityContextId: context?.id ?? null,
    revision: context?.revision ?? null,
    ...summary,
    env,
  };
}
