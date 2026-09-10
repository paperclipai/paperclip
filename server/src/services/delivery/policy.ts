import { and, desc, eq } from "drizzle-orm";
import {
  deliveryPolicies,
  deliveryRepositories,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import {
  conflict,
  unprocessable,
} from "../../errors.js";
import type {
  DeliveryBlocker,
  DeliveryMergeMethod,
  DeliveryMergeQueueMode,
  DeliveryPolicy,
  DeliveryPolicyAuthorization,
  DeliveryAutoDeployDisposition,
  DeliveryCheck,
} from "@paperclipai/shared";
import { createGitHubDeliveryClient, type GitHubDeliveryClient } from "./github-client.js";

const GITHUB_URL_PATTERN = /^(?:https?:\/\/)?(?:www\.)?(github\.com)[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;

export type ParsedRepository = { host: string; owner: string; name: string };

export function parseGitHubRepositoryUrl(value: string | null | undefined): ParsedRepository | null {
  if (!value) return null;
  const match = GITHUB_URL_PATTERN.exec(value.trim());
  if (!match) return null;
  return { host: match[1]!.toLowerCase(), owner: match[2]!, name: match[3]! };
}

export function repositoryFullName(owner: string, name: string) {
  return `${owner}/${name}`;
}

export type DeliveryPolicyRow = typeof deliveryPolicies.$inferSelect;
export type DeliveryRepositoryRow = typeof deliveryRepositories.$inferSelect;

export type PolicyWriteInput = {
  enabled?: boolean;
  paused?: boolean;
  targetBranch?: string;
  mergeMethod?: DeliveryMergeMethod;
  mergeQueueMode?: DeliveryMergeQueueMode;
  requiredChecks?: string[];
  requireGreptile?: boolean;
  requireIndependentApproval?: boolean;
  githubConnectionId?: string | null;
  greptileConnectionId?: string | null;
  autoDeployDisposition?: DeliveryAutoDeployDisposition;
  authorization?: DeliveryPolicyAuthorization | null;
  repositoryUrl?: string | null;
};

/**
 * Whether a policy write changes the authorized scope: repository identity,
 * target branch, merge mechanics, acceptance criteria, connections, or
 * deployment disposition. Any such change voids the standing authorization
 * unless the same write carries a fresh one.
 */
export function isMaterialPolicyScopeChange(input: {
  existing: Pick<
    DeliveryPolicyRow,
    "repositoryId" | "targetBranch" | "mergeMethod" | "mergeQueueMode" | "requiredChecks"
    | "requireGreptile" | "requireIndependentApproval" | "githubConnectionId"
    | "greptileConnectionId" | "autoDeployDisposition"
  >;
  patch: PolicyWriteInput;
  nextRepositoryId: string | null;
}): boolean {
  const { existing, patch } = input;
  return (
    (patch.repositoryUrl !== undefined && (input.nextRepositoryId ?? null) !== (existing.repositoryId ?? null))
    || (patch.targetBranch !== undefined && patch.targetBranch !== existing.targetBranch)
    || (patch.mergeMethod !== undefined && patch.mergeMethod !== existing.mergeMethod)
    || (patch.mergeQueueMode !== undefined && patch.mergeQueueMode !== existing.mergeQueueMode)
    || (patch.requiredChecks !== undefined && JSON.stringify(patch.requiredChecks) !== JSON.stringify(existing.requiredChecks))
    || (patch.requireGreptile !== undefined && patch.requireGreptile !== existing.requireGreptile)
    || (patch.requireIndependentApproval !== undefined && patch.requireIndependentApproval !== existing.requireIndependentApproval)
    || (patch.githubConnectionId !== undefined && (patch.githubConnectionId ?? null) !== (existing.githubConnectionId ?? null))
    || (patch.greptileConnectionId !== undefined && (patch.greptileConnectionId ?? null) !== (existing.greptileConnectionId ?? null))
    || (patch.autoDeployDisposition !== undefined && patch.autoDeployDisposition !== existing.autoDeployDisposition)
  );
}
export type PolicyDecision = {
  allowed: boolean;
  blocker: DeliveryBlocker | null;
  repository: DeliveryRepositoryRow | null;
  policy: DeliveryPolicyRow | null;
};

/**
 * Evidence for a merge decision.
 *
 * `checks`, `reviewStatus`, and `approvals` are `null` when the authoritative
 * GitHub read failed. A failed read is never equivalent to "nothing is
 * blocking": it blocks, so cached successful metadata can never be reused as
 * merge evidence.
 */
export type DeliveryEvidence = {
  headSha: string | null;
  checks: DeliveryCheck[] | null;
  reviewStatus: string | null;
  reviewHeadSha: string | null;
  approvals: Array<{ login: string; commitSha: string | null }> | null;
  prAuthorLogin: string | null;
  blockingFindings: number;
};

/**
 * The acceptance rules, independent of policy storage.
 *
 * Fail-closed by construction: unreadable evidence blocks, a missing review
 * author blocks, and an independent approval only counts when a reviewer other
 * than the author approved the exact head under evaluation.
 */
export function evaluateDeliveryRequirements(input: {
  requireIndependentApproval: boolean;
  requireGreptile: boolean;
  requiredChecks: string[];
  evidence: DeliveryEvidence;
}): DeliveryBlocker | null {
  const { evidence } = input;
  if (evidence.checks === null) {
    return {
      reasonCode: "provider_unknown",
      message: "Checks could not be read from GitHub for the current head",
      owner: null,
      nextAction: "Reconcile again once GitHub is reachable.",
    };
  }
  if (evidence.reviewStatus === null || evidence.approvals === null) {
    return {
      reasonCode: "provider_unknown",
      message: "Reviews could not be read from GitHub for the current head",
      owner: null,
      nextAction: "Reconcile again once GitHub is reachable.",
    };
  }
  if (input.requiredChecks.length > 0) {
    const failing = evidence.checks.filter((check) =>
      input.requiredChecks.includes(check.name) && !isCheckSuccessful(check.status));
    if (failing.length > 0) {
      return {
        reasonCode: "checks_failing",
        message: `Required checks failing: ${failing.map((check) => check.name).join(", ")}`,
        owner: null,
        nextAction: "Repair the failing checks and re-run them on the current head.",
      };
    }
    const missing = input.requiredChecks.filter((name) => !evidence.checks!.some((check) => check.name === name));
    if (missing.length > 0) {
      return {
        reasonCode: "checks_pending",
        message: `Required checks missing: ${missing.join(", ")}`,
        owner: null,
        nextAction: "Wait for required checks to report on the current head.",
      };
    }
  }
  if (evidence.blockingFindings > 0 || evidence.reviewStatus === "changes_requested") {
    return {
      reasonCode: "review_blocking_findings",
      message: "Review has unresolved blocking findings",
      owner: null,
      nextAction: "Resolve or disposition the blocking findings.",
    };
  }
  if (evidence.reviewStatus === "approved" && (!evidence.reviewHeadSha || evidence.reviewHeadSha !== evidence.headSha)) {
    return {
      reasonCode: "review_head_stale",
      message: "The approving review is not for the current head",
      owner: null,
      nextAction: "Re-request review on the current head.",
    };
  }
  if (input.requireIndependentApproval) {
    const author = evidence.prAuthorLogin?.trim().toLowerCase() ?? null;
    if (!author) {
      return {
        reasonCode: "provider_unknown",
        message: "Pull request author identity is unknown; independent approval cannot be proven",
        owner: null,
        nextAction: "Reconcile again so the pull request author is read from GitHub.",
      };
    }
    const independent = evidence.approvals.some((approval) =>
      approval.commitSha === evidence.headSha
      && approval.login.trim().toLowerCase() !== author);
    if (!independent) {
      return {
        reasonCode: "review_approval_required",
        message: "Independent approval required: no reviewer other than the author approved the current head",
        owner: null,
        nextAction: "Obtain an APPROVED GitHub review on the current commit from an authorized reviewer other than the pull request author. Internal candidate acceptance is not a GitHub approval.",
      };
    }
  }
  if (evidence.reviewStatus === "none" && input.requiredChecks.length === 0 && !input.requireGreptile) {
    return {
      reasonCode: "review_blocking_findings",
      message: "No accepted review evidence exists for the current head",
      owner: null,
      nextAction: "Obtain a review or configure required checks.",
    };
  }
  return null;
}

export function deliveryPolicyService(db: Db, deps: { github?: GitHubDeliveryClient } = {}): DeliveryPolicyService {
  const github = deps.github ?? createGitHubDeliveryClient(db);

  function toPolicy(row: DeliveryPolicyRow, repository: DeliveryRepositoryRow | null): DeliveryPolicy {
    return {
      id: row.id,
      companyId: row.companyId,
      projectId: row.projectId,
      repositoryId: row.repositoryId,
      repository: repository ? repositoryFullName(repository.owner, repository.name) : null,
      repositoryHost: repository?.host ?? "github.com",
      repositoryOwner: repository?.owner ?? null,
      repositoryName: repository?.name ?? null,
      githubRepositoryId: repository?.githubRepositoryId ?? null,
      targetBranch: row.targetBranch,
      enabled: row.enabled,
      paused: row.paused,
      mergeMethod: row.mergeMethod,
      mergeQueueMode: row.mergeQueueMode,
      requiredChecks: row.requiredChecks,
      requireGreptile: row.requireGreptile,
      requireIndependentApproval: row.requireIndependentApproval,
      githubConnectionId: row.githubConnectionId,
      greptileConnectionId: row.greptileConnectionId,
      autoDeployDisposition: row.autoDeployDisposition as DeliveryAutoDeployDisposition,
      authorization: row.authorization,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function loadRepository(companyId: string, repositoryId: string | null): Promise<DeliveryRepositoryRow | null> {
    if (!repositoryId) return null;
    return await db
      .select()
      .from(deliveryRepositories)
      .where(and(eq(deliveryRepositories.companyId, companyId), eq(deliveryRepositories.id, repositoryId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getForProject(companyId: string, projectId: string): Promise<DeliveryPolicy | null> {
    const [row] = await db
      .select()
      .from(deliveryPolicies)
      .where(and(eq(deliveryPolicies.companyId, companyId), eq(deliveryPolicies.projectId, projectId)))
      .limit(1);
    if (!row) return null;
    return toPolicy(row, await loadRepository(companyId, row.repositoryId));
  }

  async function getRowForProject(companyId: string, projectId: string): Promise<DeliveryPolicyRow | null> {
    return await db
      .select()
      .from(deliveryPolicies)
      .where(and(eq(deliveryPolicies.companyId, companyId), eq(deliveryPolicies.projectId, projectId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  /** Company-scoped lookup used by the Done gate, which has no project context. */
  async function getRowForIssueProject(companyId: string, projectId: string | null): Promise<DeliveryPolicyRow | null> {
    if (!projectId) return null;
    return getRowForProject(companyId, projectId);
  }

  async function resolveProjectRepositoryUrl(companyId: string, projectId: string): Promise<string | null> {
    const workspaces = await db
      .select({ repoUrl: projectWorkspaces.repoUrl, isPrimary: projectWorkspaces.isPrimary })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, projectId)))
      .orderBy(desc(projectWorkspaces.isPrimary), desc(projectWorkspaces.createdAt));
    for (const workspace of workspaces) {
      if (workspace.repoUrl && parseGitHubRepositoryUrl(workspace.repoUrl)) return workspace.repoUrl;
    }
    return null;
  }

  /**
   * Verify (and cache) the canonical repository identity. GitHub's numeric id is
   * authoritative: a matching id with different owner/name is a rename and
   * updates the canonical row instead of creating a second queue.
   */
  async function resolveRepository(input: {
    companyId: string;
    projectId: string;
    connectionId: string | null;
    repositoryUrl?: string | null;
  }): Promise<{ repository: DeliveryRepositoryRow; failure: null } | { repository: null; failure: DeliveryBlocker }> {
    const rawUrl = input.repositoryUrl ?? (await resolveProjectRepositoryUrl(input.companyId, input.projectId));
    const parsed = parseGitHubRepositoryUrl(rawUrl);
    if (!parsed) {
      return {
        repository: null,
        failure: {
          reasonCode: "repository_unverified",
          message: "Project has no GitHub repository configured",
          owner: null,
          nextAction: "Set the project's primary workspace repository URL or pass repositoryUrl in the policy update.",
        },
      };
    }
    const verified = await github.getRepository(
      input.companyId, input.connectionId, parsed.host, parsed.owner, parsed.name,
    );
    if (!verified.ok) {
      return {
        repository: null,
        failure: {
          reasonCode: verified.errorCode === "connection_missing" ? "connection_missing" : "repository_unverified",
          message: verified.message,
          owner: null,
          nextAction: "Reconnect the GitHub connection or correct the project repository URL.",
        },
      };
    }
    const identity = verified.value;
    const now = new Date();
    const byId = await db
      .select()
      .from(deliveryRepositories)
      .where(and(
        eq(deliveryRepositories.companyId, input.companyId),
        eq(deliveryRepositories.githubRepositoryId, identity.id),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const byName = await db
      .select()
      .from(deliveryRepositories)
      .where(and(
        eq(deliveryRepositories.companyId, input.companyId),
        eq(deliveryRepositories.host, parsed.host),
        eq(deliveryRepositories.owner, parsed.owner),
        eq(deliveryRepositories.name, parsed.name),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (byId && byName && byId.id !== byName.id) {
      throw conflict("Repository identity conflicts with an existing delivery repository", {
        repositoryId: byId.id,
        conflictingRepositoryId: byName.id,
      });
    }
    const existing = byId ?? byName;
    if (!existing) {
      const [created] = await db
        .insert(deliveryRepositories)
        .values({
          companyId: input.companyId,
          provider: "github",
          host: parsed.host,
          owner: identity.owner,
          name: identity.name,
          githubRepositoryId: identity.id,
          defaultBranch: identity.defaultBranch,
          connectionId: input.connectionId,
          verifiedAt: now,
          lastError: null,
        })
        .returning();
      return { repository: created!, failure: null };
    }
    const renamed = existing.owner !== identity.owner || existing.name !== identity.name;
    const [updated] = await db
      .update(deliveryRepositories)
      .set({
        owner: identity.owner,
        name: identity.name,
        githubRepositoryId: identity.id,
        defaultBranch: identity.defaultBranch,
        connectionId: input.connectionId ?? existing.connectionId,
        verifiedAt: now,
        ...(renamed ? { renameVerifiedAt: now } : {}),
        lastError: null,
        updatedAt: now,
      })
      .where(eq(deliveryRepositories.id, existing.id))
      .returning();
    return { repository: updated!, failure: null };
  }

  async function upsertPolicy(input: {
    companyId: string;
    projectId: string;
    actorUserId: string | null;
    patch: PolicyWriteInput;
  }): Promise<DeliveryPolicy> {
    const existing = await getRowForProject(input.companyId, input.projectId);
    const nextConnectionId = input.patch.githubConnectionId !== undefined
      ? input.patch.githubConnectionId
      : existing?.githubConnectionId ?? null;
    const targetBranch = input.patch.targetBranch ?? existing?.targetBranch ?? "main";

    let repository: DeliveryRepositoryRow | null = await loadRepository(input.companyId, existing?.repositoryId ?? null);
    const repositoryUrlProvided = input.patch.repositoryUrl !== undefined || existing?.repositoryId == null;
    const willEnable = input.patch.enabled ?? existing?.enabled ?? false;
    if (repositoryUrlProvided) {
      const resolved = await resolveRepository({
        companyId: input.companyId,
        projectId: input.projectId,
        connectionId: nextConnectionId,
        repositoryUrl: input.patch.repositoryUrl ?? null,
      });
      if (resolved.repository) {
        repository = resolved.repository;
      } else if (willEnable || input.patch.repositoryUrl !== undefined) {
        // A disabled policy may be saved before the connection/repository is
        // ready; enabling it or pinning a URL must resolve successfully.
        throw unprocessable(resolved.failure.message, { reasonCode: resolved.failure.reasonCode });
      }
    }

    if (input.patch.authorization === null && input.patch.enabled === true) {
      throw unprocessable("Enabling delivery requires an operator authorization record");
    }
    if (input.patch.authorization != null) {
      if (input.actorUserId === null) {
        throw conflict("Only an operator session may grant delivery authorization");
      }
      if (input.patch.authorization.approvedByUserId !== input.actorUserId) {
        throw unprocessable("Authorization must name the approving operator");
      }
    }
    const materialScopeChanged = existing != null && isMaterialPolicyScopeChange({
      existing,
      patch: input.patch,
      nextRepositoryId: repository?.id ?? null,
    });
    // A standing authorization names the scope it approved. Any material scope
    // change voids it: the operator must re-authorize the new target,
    // repository, acceptance criteria, or deployment disposition explicitly.
    // Supplying a fresh authorization in the same write re-authorizes at once.
    const authorization = input.patch.authorization !== undefined
      ? input.patch.authorization
      : materialScopeChanged
        ? null
        : existing?.authorization ?? null;
    const values = {
      companyId: input.companyId,
      projectId: input.projectId,
      repositoryId: repository?.id ?? null,
      targetBranch,
      enabled: input.patch.enabled ?? existing?.enabled ?? false,
      paused: input.patch.paused ?? existing?.paused ?? false,
      mergeMethod: input.patch.mergeMethod ?? existing?.mergeMethod ?? "squash",
      mergeQueueMode: input.patch.mergeQueueMode ?? existing?.mergeQueueMode ?? "serialized",
      requiredChecks: input.patch.requiredChecks ?? existing?.requiredChecks ?? [],
      requireGreptile: input.patch.requireGreptile ?? existing?.requireGreptile ?? false,
      requireIndependentApproval: input.patch.requireIndependentApproval ?? existing?.requireIndependentApproval ?? true,
      githubConnectionId: nextConnectionId,
      greptileConnectionId: input.patch.greptileConnectionId !== undefined
        ? input.patch.greptileConnectionId
        : existing?.greptileConnectionId ?? null,
      autoDeployDisposition: input.patch.autoDeployDisposition ?? existing?.autoDeployDisposition ?? "none",
      authorization,
      version: (existing?.version ?? 0) + 1,
      createdByUserId: existing?.createdByUserId ?? input.actorUserId,
      updatedByUserId: input.actorUserId,
      updatedAt: new Date(),
    };
    if (existing) {
      const [updated] = await db
        .update(deliveryPolicies)
        .set(values)
        .where(eq(deliveryPolicies.id, existing.id))
        .returning();
      return toPolicy(updated!, repository);
    }
    const [created] = await db.insert(deliveryPolicies).values(values).returning();
    return toPolicy(created!, repository);
  }

  /**
   * Policy gate for a unit. Returns the first blocking reason, in a fixed
   * precedence, so a blocker is stable across reconciliations.
   */
  async function evaluateUnit(input: {
    companyId: string;
    projectId: string | null;
    targetBranch: string;
    evidence: DeliveryEvidence;
    requireGreptile: boolean;
  }): Promise<PolicyDecision> {
    const row = await getRowForIssueProject(input.companyId, input.projectId);
    if (!row) {
      return {
        allowed: false,
        repository: null,
        policy: null,
        blocker: { reasonCode: "policy_missing", message: "Project has no delivery policy", owner: null, nextAction: "Configure a delivery policy for this project." },
      };
    }
    const repository = await loadRepository(input.companyId, row.repositoryId);
    if (!row.enabled) {
      return {
        allowed: false, repository, policy: row,
        blocker: { reasonCode: "policy_disabled", message: "Delivery is not enabled for this project", owner: null, nextAction: "Enable the delivery policy." },
      };
    }
    if (row.paused) {
      return {
        allowed: false, repository, policy: row,
        blocker: { reasonCode: "policy_paused", message: "Delivery is paused for this project", owner: null, nextAction: "Resume the delivery policy." },
      };
    }
    if (!repository) {
      return {
        allowed: false, repository, policy: row,
        blocker: { reasonCode: "repository_unverified", message: "Repository identity is not verified", owner: null, nextAction: "Re-verify the project repository." },
      };
    }
    if (row.targetBranch !== input.targetBranch) {
      return {
        allowed: false, repository, policy: row,
        blocker: { reasonCode: "base_stale", message: `Delivery targets ${row.targetBranch}, not ${input.targetBranch}`, owner: null, nextAction: `Re-target the candidate to ${row.targetBranch}.` },
      };
    }
    if (!row.authorization) {
      return {
        allowed: false, repository, policy: row,
        blocker: { reasonCode: "deployment_authority_missing", message: "Delivery policy has no operator authorization record", owner: null, nextAction: "Record operator authorization on the delivery policy." },
      };
    }
    if (row.autoDeployDisposition === "block_merge") {
      return {
        allowed: false, repository, policy: row,
        blocker: { reasonCode: "deployment_authority_missing", message: "Policy blocks merging to this target", owner: null, nextAction: "Record a verified deployment disposition before permitting merges." },
      };
    }
    if (row.autoDeployDisposition === "none" && repository.defaultBranch === input.targetBranch) {
      return {
        allowed: false, repository, policy: row,
        blocker: {
          reasonCode: "deployment_authority_missing",
          message: "Merging to the default branch has unknown deployment behaviour and no recorded authority",
          owner: null,
          nextAction: "Record no_auto_deploy after verifying trigger separation, authorized when deployment is permitted, or block_merge.",
        },
      };
    }
    if (row.requireGreptile && input.requireGreptile === false) {
      return {
        allowed: false, repository, policy: row,
        blocker: { reasonCode: "greptile_required", message: "Policy requires a Greptile review", owner: null, nextAction: "Connect Greptile and refresh the review." },
      };
    }
    const requirementBlocker = evaluateDeliveryRequirements({
      requireIndependentApproval: row.requireIndependentApproval,
      requireGreptile: row.requireGreptile,
      requiredChecks: row.requiredChecks,
      evidence: input.evidence,
    });
    if (requirementBlocker) {
      return { allowed: false, repository, policy: row, blocker: requirementBlocker };
    }
    return { allowed: true, blocker: null, repository, policy: row };
  }

  return {
    toPolicy,
    getForProject,
    getRowForProject,
    getRowForIssueProject,
    resolveRepository,
    upsertPolicy,
    evaluateUnit,
    parseGitHubRepositoryUrl,
  };
}

export function isCheckSuccessful(status: string) {
  const normalized = status.toLowerCase();
  return normalized === "success" || normalized === "successful" || normalized === "passed" || normalized === "neutral" || normalized === "skipped";
}

export interface DeliveryPolicyService {
  toPolicy(row: DeliveryPolicyRow, repository: DeliveryRepositoryRow | null): DeliveryPolicy;
  getForProject(companyId: string, projectId: string): Promise<DeliveryPolicy | null>;
  getRowForProject(companyId: string, projectId: string): Promise<DeliveryPolicyRow | null>;
  getRowForIssueProject(companyId: string, projectId: string | null): Promise<DeliveryPolicyRow | null>;
  resolveRepository(input: {
    companyId: string;
    projectId: string;
    connectionId: string | null;
    repositoryUrl?: string | null;
  }): Promise<
    | { repository: DeliveryRepositoryRow; failure: null }
    | { repository: null; failure: DeliveryBlocker }
  >;
  upsertPolicy(input: {
    companyId: string;
    projectId: string;
    actorUserId: string | null;
    patch: PolicyWriteInput;
  }): Promise<DeliveryPolicy>;
  evaluateUnit(input: {
    companyId: string;
    projectId: string | null;
    targetBranch: string;
    evidence: DeliveryEvidence;
    requireGreptile: boolean;
  }): Promise<PolicyDecision>;
  parseGitHubRepositoryUrl(value: string | null | undefined): ParsedRepository | null;
}
