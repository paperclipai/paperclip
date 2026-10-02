import { z } from "zod";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  chatEndpoints,
  chatEndpointResources,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatGitHubReviews,
  chatIdentityLinks,
  companyMemberships,
  type Db,
} from "@paperclipai/db";
import {
  githubCommitSchema,
  githubIdSchema,
  type GitHubReviewEventContext,
} from "@paperclipai/shared";
import {
  effectiveGitHubReviewPolicy,
  githubReviewSchedulingDecision,
} from "./chat-github-review-policy.js";

const id = z.union([
  githubIdSchema,
  z.number().int().positive().safe().transform(String),
]);
const person = z.object({
  id,
  login: z.string().min(1).max(100),
  type: z.string().optional(),
});
const payloadSchema = z.object({
  action: z.enum(["opened", "synchronize", "reopened", "ready_for_review"]),
  repository: z.object({
    id,
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  }),
  sender: person,
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().max(1000),
    body: z.string().nullable(),
    draft: z.boolean(),
    base: z.object({ sha: githubCommitSchema, ref: z.string() }),
    head: z.object({ sha: githubCommitSchema }),
    user: person,
    labels: z.array(z.object({ name: z.string() })).default([]),
  }),
  before: githubCommitSchema.optional(),
});

/** Called only after signature and installed-repository admission. */
export function githubAutomaticReviewEvent(
  payload: unknown,
  deliveryId: string,
): GitHubReviewEventContext | null {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { data } = parsed;
  const pr = data.pull_request;
  return {
    event: data.action,
    deliveryId,
    repositoryId: data.repository.id,
    repository: data.repository.full_name.toLowerCase(),
    pullNumber: pr.number,
    title: pr.title,
    body: (pr.body ?? "").slice(0, 24000),
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
    author: {
      id: pr.user.id,
      login: pr.user.login,
      isBot: pr.user.type === "Bot",
    },
    sender: { id: data.sender.id, login: data.sender.login },
    draft: pr.draft,
    labels: pr.labels.map((label) => label.name),
    previousHeadSha: data.before,
  };
}

export async function githubAutomaticAdmission(
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
  endpoint: typeof chatEndpoints.$inferSelect,
  context: GitHubReviewEventContext,
) {
  const [saved] = await db
    .select()
    .from(chatGitHubConfigurations)
    .where(
      and(
        eq(chatGitHubConfigurations.companyId, endpoint.companyId),
        eq(chatGitHubConfigurations.endpointId, endpoint.id),
      ),
    );
  if (!saved) return null;
  const [resource] = await db
    .select()
    .from(chatEndpointResources)
    .where(
      and(
        eq(chatEndpointResources.companyId, endpoint.companyId),
        eq(chatEndpointResources.endpointId, endpoint.id),
        eq(
          chatEndpointResources.providerResourceId,
          context.repository.toLowerCase(),
        ),
      ),
    );
  const [link] = await db
    .select({
      userId: chatIdentityLinks.paperclipUserId,
      status: chatIdentityLinks.status,
    })
    .from(chatExternalPrincipals)
    .innerJoin(
      chatIdentityLinks,
      eq(chatIdentityLinks.principalId, chatExternalPrincipals.id),
    )
    .where(
      and(
        eq(chatExternalPrincipals.companyId, endpoint.companyId),
        eq(chatExternalPrincipals.provider, "github"),
        eq(chatExternalPrincipals.externalId, context.author.id),
        eq(chatIdentityLinks.endpointId, endpoint.id),
      ),
    );
  const members = await db
    .select()
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, endpoint.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    );
  const active = new Set(
    members
      .filter((member) => member.membershipRole !== "viewer")
      .map((member) => member.principalId),
  );
  const decision = githubReviewSchedulingDecision({
    configuration: saved.configuration,
    context,
    repositoryEnabled:
      !!resource?.enabled &&
      resource.availability === "available" &&
      String(resource.metadata?.providerRepositoryId) === context.repositoryId,
    linkedMemberUserId:
      link?.status === "linked" && link.userId && active.has(link.userId)
        ? link.userId
        : null,
    activeSponsorUserIds: active,
    manual: false,
  });
  // An explicitly revoked link must not regain authority through guest fallback.
  if (link?.status === "revoked")
    return {
      ...decision,
      allowed: false,
      reason: "identity_revoked",
      revision: saved.revision,
      policy: effectiveGitHubReviewPolicy(
        saved.configuration,
        context.repositoryId,
      ),
    };
  return {
    ...decision,
    revision: saved.revision,
    policy: effectiveGitHubReviewPolicy(
      saved.configuration,
      context.repositoryId,
    ),
  };
}

export async function githubPreviousAssessment(
  db: Db,
  endpoint: typeof chatEndpoints.$inferSelect,
  repositoryId: string,
  pullNumber: number,
) {
  const [review] = await db
    .select()
    .from(chatGitHubReviews)
    .where(
      and(
        eq(chatGitHubReviews.companyId, endpoint.companyId),
        eq(chatGitHubReviews.endpointId, endpoint.id),
        eq(chatGitHubReviews.repositoryId, repositoryId),
        eq(chatGitHubReviews.pullNumber, pullNumber),
        isNotNull(chatGitHubReviews.assessment),
      ),
    )
    .orderBy(desc(chatGitHubReviews.createdAt))
    .limit(1);
  return review ?? null;
}
