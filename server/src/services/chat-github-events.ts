import { z } from "zod";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
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
  type GitHubIssueEventContext,
  type GitHubAutomaticEventContext,
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

export function githubBodyMentionsBot(body: string, username: string | null): boolean {
  if (!username) return false;
  const name = username.replace(/\[bot\]$/i, "");
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])@${escaped}(?:\\[bot\\])?(?![\\w-])`, "i").test(body);
}

/**
 * A thread subscription must not turn a request for another connected bot
 * into work for this bot. Human mentions still follow ordinary thread policy,
 * and explicitly mentioning this bot (including alongside another) wins. */
export async function githubMessageAddressesAnotherBot(
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
  endpoint: Pick<typeof chatEndpoints.$inferSelect, "id" | "companyId" | "botUsername">,
  body: string,
): Promise<boolean> {
  if (!body.includes("@") || githubBodyMentionsBot(body, endpoint.botUsername)) return false;
  const others = await db
    .select({ username: chatEndpoints.botUsername })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.companyId, endpoint.companyId),
        eq(chatEndpoints.provider, "github"),
        ne(chatEndpoints.id, endpoint.id),
        ne(chatEndpoints.status, "archived"),
        isNotNull(chatEndpoints.botUsername),
      ),
    );
  return others.some((other) => githubBodyMentionsBot(body, other.username));
}

const mentionPayloadSchema = z.object({
  action: z.string(),
  repository: z.object({ id, full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }),
  sender: person,
  changes: z.object({ body: z.object({ from: z.string().nullable() }).optional() }).optional(),
});
const descriptionSchema = z.object({
  number: z.number().int().positive().safe(),
  body: z.string().nullable(),
  pull_request: z.unknown().optional(),
});
const commentSchema = z.object({
  id,
  body: z.string().nullable(),
  in_reply_to_id: id.optional(),
});

/** Explicit requests use the ordinary message admission path, including the
 * actor who made an edit, rather than the automatic event's original author. */
export function githubExplicitMentionEvent(
  eventType: string,
  payload: unknown,
  deliveryId: string,
  botUsername: string | null,
) {
  const parsed = mentionPayloadSchema.safeParse(payload);
  if (!parsed.success || !deliveryId) return null;
  const envelope = parsed.data;
  const source = payload as Record<string, unknown>;
  const isIssue = eventType === "issues" || eventType === "issue_comment";
  const target = descriptionSchema.safeParse(source[isIssue ? "issue" : "pull_request"]);
  if (!target.success) return null;
  const description = eventType === "issues" || eventType === "pull_request";
  const review = eventType === "pull_request_review";
  if (!description && !review && !["issue_comment", "pull_request_review_comment"].includes(eventType)) return null;
  if (eventType === "issues" && target.data.pull_request !== undefined) return null;
  const content = description ? target : commentSchema.safeParse(source[review ? "review" : "comment"]);
  if (!content.success) return null;
  const body = content.data.body ?? "";
  if (!githubBodyMentionsBot(body, botUsername)) return null;
  const edited = envelope.action === "edited";
  if (edited) {
    // A title/label edit, push, or unrelated edit retaining an old mention
    // must not rerun the request. Missing previous content is not evidence
    // that the editor added a mention.
    if (!envelope.changes?.body || githubBodyMentionsBot(envelope.changes.body.from ?? "", botUsername)) return null;
  } else if (envelope.action !== (description ? "opened" : review ? "submitted" : "created")) return null;
  if (envelope.sender.type === "Bot") return null;
  const repository = envelope.repository.full_name.toLowerCase();
  const number = target.data.number;
  const issueThread = isIssue && target.data.pull_request === undefined;
  const comment = !description && !review ? commentSchema.parse(source.comment) : null;
  const reviewId = review ? commentSchema.parse(source.review).id : null;
  // Match the native adapter's repository casing so addressed descriptions
  // and ordinary follow-up comments share the same existing conversation.
  const threadId = `github:${envelope.repository.full_name}:${issueThread ? "issue:" : ""}${number}${eventType === "pull_request_review_comment" ? `:rc:${comment!.in_reply_to_id ?? comment!.id}` : ""}`;
  return {
    threadId,
    // Created comments retain the SDK's identity so alternate delivery paths
    // cannot duplicate a turn. Edits are separate, delivery-deduplicated asks.
    messageId: edited || description ? `mention-event:${deliveryId}` : review ? `review:${reviewId}` : comment!.id,
    sourceMessageId: comment?.id ?? null,
    body: body.slice(0, 65536),
    sender: envelope.sender,
    edited,
    receiptReactionSupported: !description && !review && !edited,
    url: `https://github.com/${repository}/${issueThread ? "issues" : "pull"}/${number}${description ? "" : review ? `#pullrequestreview-${reviewId}` : eventType === "pull_request_review_comment" ? `#discussion_r${comment!.id}` : `#issuecomment-${comment!.id}`}`,
    raw: comment ? {
      type: eventType === "pull_request_review_comment" ? "review_comment" : "issue_comment",
      comment: source.comment, repository: source.repository, prNumber: number, threadType: issueThread ? "issue" : "pr",
    } : {
      type: description ? issueThread ? "issue_description" : "pull_request_description" : "review_summary",
      source: source[description ? isIssue ? "issue" : "pull_request" : "review"],
      repository: source.repository, prNumber: number, threadType: issueThread ? "issue" : "pr",
    },
  };
}
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

const issuePayloadSchema = z.object({
  action: z.literal("opened"),
  repository: payloadSchema.shape.repository,
  sender: person,
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string().max(1000),
    body: z.string().nullable(),
    user: person,
    labels: z.array(z.object({ name: z.string() })).default([]),
    pull_request: z.unknown().optional(),
  }),
});

/** Called only after signature and installation/repository verification. */
export function githubAutomaticIssueEvent(payload: unknown, deliveryId: string): GitHubIssueEventContext | null {
  const parsed = issuePayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.issue.pull_request !== undefined) return null;
  const { repository, sender, issue } = parsed.data;
  return {
    event: "issue_opened", deliveryId,
    repositoryId: repository.id, repository: repository.full_name.toLowerCase(),
    issueNumber: issue.number, title: issue.title, body: (issue.body ?? "").slice(0, 24000),
    author: { id: issue.user.id, login: issue.user.login, isBot: issue.user.type === "Bot" },
    sender: { id: sender.id, login: sender.login }, labels: issue.labels.map(label => label.name),
  };
}

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
  context: GitHubAutomaticEventContext,
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
