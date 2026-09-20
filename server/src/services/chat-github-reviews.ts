import { runtimePublicOrigin } from "./cloud-runtime-identity.js";
import { projectSafeChatPublicationText } from "./chat-publication-projection.js";
import { githubReviewCheckService } from "./chat-github-checks.js";
import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  toolInvocations,
  agents,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatGitHubConfigurations,
  chatGitHubReviews,
  chatMessageLinks,
  heartbeatRuns,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  githubCommitSchema,
  type GitHubReviewEventContext,
  type GitHubReviewPolicy,
} from "@paperclipai/shared";
import { HttpError, conflict, forbidden, notFound } from "../errors.js";
import {
  githubBotRepositoryToken,
  githubBotRequest,
} from "./chat-github-client.js";
import { githubChatPrincipalAccess } from "./chat-github-access.js";
import {
  effectiveGitHubReviewPolicy,
  githubReviewConclusion,
  githubReviewPathIsExcluded,
  githubReviewLineIsInPatch,
  validateGitHubReviewAssessment,
} from "./chat-github-review-policy.js";
import {
  isIssueWithinLowTrustBoundary,
  resolveCoreTrustPreset,
} from "./trust-preset-resolver.js";
import { githubBotToolsForSession } from "./chat-github-tools.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import {
  githubAutomaticAdmission,
  githubPreviousAssessment,
} from "./chat-github-events.js";
import { logActivity } from "./activity-log.js";

type Session = {
  companyId: string;
  agentId: string | null;
  issueId: string | null;
  runId: string | null;
};
type Pull = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  head: { sha: string };
  base: { sha: string; ref: string };
  user: { id: number; login: string; type: string };
  labels: Array<{ name: string }>;
};
type File = {
  filename: string;
  previous_filename?: string;
  patch?: string;
  status: string;
  additions: number;
  deletions: number;
};
const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? Object.fromEntries(
              Object.keys(entry)
                .sort()
                .map((key) => [key, entry[key]]),
            )
          : entry,
      ),
    )
    .digest("hex");
const marker = (kind: string, key: string) =>
  `<!-- paperclip-${kind}:${hash(key)} -->`;
const readSchema = z
  .object({
    section: z.enum([
      "metadata",
      "files",
      "comments",
      "reviews",
      "changes_since_review",
    ]),
    page: z.number().int().min(1).max(100).default(1),
  })
  .strict();
const commentSchema = z
  .object({
    body: z.string().trim().min(1).max(24000),
    idempotencyKey: z.string().min(1).max(160),
  })
  .strict();
const formalSchema = commentSchema
  .extend({
    event: z.enum(["APPROVE", "REQUEST_CHANGES"]),
    reviewedCommit: githubCommitSchema,
  })
  .strict();

export function githubChatReviewService(db: Db, fetchImpl = fetch) {
  async function scope(session: Session, publishing = false) {
    if (!session.agentId || !session.issueId || !session.runId)
      throw forbidden(
        "GitHub bot tools require an active assigned-agent task run",
      );
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, session.runId),
          eq(heartbeatRuns.companyId, session.companyId),
          eq(heartbeatRuns.agentId, session.agentId),
        ),
      );
    const taskId =
      run?.nativeIssueId ??
      run?.contextSnapshot?.issueId ??
      run?.contextSnapshot?.taskId;
    if (
      !run ||
      taskId !== session.issueId ||
      (!publishing && run.status !== "running") ||
      (publishing && !["running", "succeeded"].includes(run.status))
    )
      throw forbidden("This task run is no longer authorized");
    const commentId = run.contextSnapshot?.wakeCommentId;
    const [source] =
      typeof commentId === "string"
        ? await db
            .select({
              conversation: chatConversations,
              delivery: chatDeliveries,
              endpoint: chatEndpoints,
              resource: chatEndpointResources,
              config: chatGitHubConfigurations,
            })
            .from(chatMessageLinks)
            .innerJoin(
              chatDeliveries,
              eq(chatDeliveries.id, chatMessageLinks.deliveryId),
            )
            .innerJoin(
              chatConversations,
              eq(chatConversations.id, chatMessageLinks.conversationId),
            )
            .innerJoin(
              chatEndpoints,
              eq(chatEndpoints.id, chatConversations.endpointId),
            )
            .innerJoin(
              chatEndpointResources,
              eq(chatEndpointResources.id, chatConversations.resourceId),
            )
            .innerJoin(
              chatGitHubConfigurations,
              eq(chatGitHubConfigurations.endpointId, chatEndpoints.id),
            )
            .where(
              and(
                eq(chatMessageLinks.companyId, session.companyId),
                eq(chatMessageLinks.commentId, commentId),
                eq(chatConversations.issueId, session.issueId),
                eq(chatEndpoints.assignedAgentId, session.agentId),
                eq(chatEndpoints.provider, "github"),
              ),
            )
        : [];
    if (
      !source ||
      !source.delivery.principalId ||
      !source.config.configuration.toolsEnabled ||
      !["active", "verifying"].includes(source.endpoint.status) ||
      !source.resource.enabled ||
      source.resource.availability !== "available"
    )
      throw forbidden(
        "This run has no active GitHub bot capability for its conversation",
      );
    const access = await githubChatPrincipalAccess(
      db,
      source.endpoint,
      source.delivery.principalId,
    );
    if (!access?.allowed)
      throw forbidden("The initiating GitHub person is no longer authorized");
    const automatic = source.delivery.normalizedEvent.githubAutomatic as
      { context: GitHubReviewEventContext } | undefined;
    if (
      automatic &&
      !(await githubAutomaticAdmission(db, source.endpoint, automatic.context))
        ?.allowed
    )
      throw forbidden("Automatic review authority is no longer available");
    const repositoryId = String(
      source.resource.metadata?.providerRepositoryId ?? "",
    );
    const repository = source.resource.providerResourceId;
    if (
      !/^[1-9][0-9]*$/.test(repositoryId) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    )
      throw conflict(
        "Refresh the bot's repository access before using its tools",
      );
    const match =
      /^github:([^:]+):(?:(issue):)?([1-9][0-9]*)(?::rc:([1-9][0-9]*))?$/.exec(
        source.conversation.externalThreadId,
      );
    if (!match || match[1]!.toLowerCase() !== repository.toLowerCase())
      throw forbidden("Invalid task repository binding");
    const [agent] = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, session.companyId),
          eq(agents.id, session.agentId),
        ),
      );
    const [issue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, session.companyId),
          eq(issues.id, session.issueId),
        ),
      );
    if (!agent || !issue || issue.assigneeAgentId !== agent.id)
      throw forbidden("The assigned agent changed");
    const [project] = issue.projectId
      ? await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.companyId, session.companyId),
              eq(projects.id, issue.projectId),
            ),
          )
      : [];
    const trust = resolveCoreTrustPreset({
      companyId: session.companyId,
      agent,
      issue,
      project,
      run: {
        companyId: session.companyId,
        executionPolicy: run.contextSnapshot?.executionPolicy,
      },
    });
    if (trust.kind === "denied")
      throw forbidden("The agent's trust policy is incomplete");
    // The caller's task/run binding is fixed; never export credentials. Review
    // submissions are governed output, not authority to mutate other tasks.
    if (
      trust.kind === "low_trust_review" &&
      (!(trust.boundary.allowedToolClasses ?? []).includes("github.pr.read") ||
        !isIssueWithinLowTrustBoundary(trust.boundary, issue))
    )
      throw forbidden(
        "The low-trust boundary does not permit GitHub review tools",
      );
    return {
      ...source,
      run,
      agent,
      issue,
      access,
      repositoryId,
      repository,
      number: Number(match[3]),
      isIssue: !!match[2],
      replyId: match[4] ?? null,
      policy: effectiveGitHubReviewPolicy(
        source.config.configuration,
        repositoryId,
      ),
    };
  }
  async function client(source: Awaited<ReturnType<typeof scope>>) {
    const token = await githubBotRepositoryToken(
      db,
      source.endpoint.companyId,
      source.endpoint.id,
      source.repositoryId,
      fetchImpl,
    );
    const prefix = `/repos/${source.repository.split("/").map(encodeURIComponent).join("/")}`;
    return {
      prefix,
      request: <T>(
        path: string,
        options?: Parameters<typeof githubBotRequest>[3],
      ) => githubBotRequest<T>(fetchImpl, token, `${prefix}${path}`, options),
    };
  }
  async function reviewForHead(
    source: Awaited<ReturnType<typeof scope>>,
    pull: Pull,
  ) {
    const [prior] = await db
      .select()
      .from(chatGitHubReviews)
      .where(
        and(
          eq(chatGitHubReviews.companyId, source.endpoint.companyId),
          eq(chatGitHubReviews.endpointId, source.endpoint.id),
          eq(chatGitHubReviews.issueId, source.issue.id),
          eq(chatGitHubReviews.headSha, pull.head.sha),
        ),
      )
      .orderBy(desc(chatGitHubReviews.createdAt))
      .limit(1);
    if (prior && prior.runId === source.run.id) return prior;
    if (prior && !prior.runId && prior.deliveryId === source.delivery.id) {
      const [claimed] = await db
        .update(chatGitHubReviews)
        .set({ runId: source.run.id, state: "running", updatedAt: new Date() })
        .where(
          and(
            eq(chatGitHubReviews.id, prior.id),
            isNull(chatGitHubReviews.runId),
          ),
        )
        .returning();
      if (claimed) return claimed;
      return reviewForHead(source, pull);
    }
    const manual = source.delivery.normalizedEvent.githubManual as
      | {
          policy: GitHubReviewPolicy;
          revision: number;
          event: "mention" | "comment";
        }
      | undefined;
    const context: GitHubReviewEventContext = {
      event: manual?.event ?? "mention",
      deliveryId: source.delivery.id,
      repositoryId: source.repositoryId,
      repository: source.repository,
      pullNumber: source.number,
      title: pull.title,
      body: pull.body ?? "",
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      baseBranch: pull.base.ref,
      draft: pull.draft,
      author: {
        id: String(pull.user.id),
        login: pull.user.login,
        isBot: pull.user.type === "Bot",
      },
      sender: {
        id: String(
          (source.delivery.normalizedEvent.principal as { externalId?: string })
            ?.externalId ?? "",
        ),
        login: String(
          (source.delivery.normalizedEvent.principal as { handle?: string })
            ?.handle ?? "",
        ),
      },
      labels: pull.labels.map((l) => l.name),
    };
    const [review] = await db
      .insert(chatGitHubReviews)
      .values({
        companyId: source.endpoint.companyId,
        endpointId: source.endpoint.id,
        issueId: source.issue.id,
        runId: source.run.id,
        repositoryId: source.repositoryId,
        repository: source.repository,
        pullNumber: source.number,
        headSha: pull.head.sha,
        deliveryId: `run:${source.run.id}:${pull.head.sha}`,
        configurationRevision: manual?.revision ?? source.config.revision,
        policySnapshot: manual?.policy ?? source.policy,
        event: context,
        state: "running",
      })
      .onConflictDoNothing()
      .returning();
    if (review) {
      await githubReviewCheckService(db, fetchImpl).enqueue(
        source.endpoint,
        context,
        true,
        "authorized_manual_request",
      );
      return review;
    }
    const [existing] = await db
      .select()
      .from(chatGitHubReviews)
      .where(
        and(
          eq(chatGitHubReviews.endpointId, source.endpoint.id),
          eq(
            chatGitHubReviews.deliveryId,
            `run:${source.run.id}:${pull.head.sha}`,
          ),
        ),
      );
    return existing!;
  }
  async function stage(
    source: Awaited<ReturnType<typeof scope>>,
    operation: string,
    payload: Record<string, unknown>,
    key: string,
    invocationId: string | undefined,
    toolName: string,
    parameters: unknown,
    writer: Db | Parameters<Parameters<Db["transaction"]>[0]>[0] = db,
  ) {
    const actionKey = `github_publication:${source.issue.id}:${operation}:${hash(key)}`;
    const values = {
      companyId: source.endpoint.companyId,
      endpointId: source.endpoint.id,
      conversationId: source.conversation.id,
      principalId: source.delivery.principalId,
      deliveryId: source.delivery.id,
      kind: "github_review_publication",
      providerActionId: actionKey,
      payload: {
        version: 1,
        operation,
        invocationId,
        toolName,
        parameters,
        runtimeGeneration:
          (source.endpoint.setup as { runtimeGeneration?: number })
            .runtimeGeneration ?? 0,
        session: {
          companyId: source.endpoint.companyId,
          agentId: source.agent.id,
          issueId: source.issue.id,
          runId: source.run.id,
        },
        ...payload,
      },
      status: "received",
    };
    const [action] = await writer
      .insert(chatActions)
      .values(values)
      .onConflictDoNothing()
      .returning();
    if (!action) {
      const [existing] = await writer
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, source.endpoint.id),
            eq(chatActions.providerActionId, actionKey),
          ),
        );
      if (
        !existing ||
        hash({ ...existing.payload, invocationId: undefined }) !==
          hash({ ...values.payload, invocationId: undefined })
      )
        throw conflict(
          "This publication key was already used for different content",
        );
      return existing.id;
    }
    return action.id;
  }
  async function receipt(actionId: string) {
    const [action] = await db
      .select({ status: chatActions.status, result: chatActions.result })
      .from(chatActions)
      .where(eq(chatActions.id, actionId));
    return {
      actionId,
      status: action?.status ?? "received",
      receipt: action?.result ?? null,
    };
  }
  async function execute(
    session: Session,
    name: string,
    input: unknown,
    invocationId?: string,
  ) {
    const source = await scope(session);
    const api = await client(source);
    if (name === "comment") {
      const parsed = commentSchema.parse(input);
      const actionId = await stage(
        source,
        "comment",
        parsed,
        parsed.idempotencyKey,
        invocationId,
        name,
        input,
      );
      await processPublication(actionId);
      return receipt(actionId);
    }
    if (source.isIssue)
      throw conflict(
        "This task is bound to a GitHub issue. Pull request review tools require a PR conversation.",
      );
    const pull = await api.request<Pull>(`/pulls/${source.number}`);
    if (name === "read_pull_request") {
      const parsed = readSchema.parse(input);
      if (parsed.section === "metadata") {
        const review = await reviewForHead(source, pull);
        const previous = await githubPreviousAssessment(
          db,
          source.endpoint,
          source.repositoryId,
          source.number,
        );
        return {
          untrusted: true,
          pull,
          reviewId: review.id,
          reviewPolicy: review.policySnapshot,
          configurationRevision: review.configurationRevision,
          previousAssessment: previous
            ? {
                reviewedCommit: previous.headSha,
                assessment: previous.assessment,
                taskId: previous.issueId,
                runId: previous.runId,
              }
            : null,
        };
      }
      if (parsed.section === "changes_since_review") {
        const previous = await githubPreviousAssessment(
          db,
          source.endpoint,
          source.repositoryId,
          source.number,
        );
        if (!previous)
          return {
            untrusted: true,
            items: [],
            priorReviewedCommit: null,
            reviewedCommit: pull.head.sha,
            guidance:
              "No previous assessment. Read all current pull request files.",
          };
        const comparison = await api.request<{
          files?: File[];
          status: string;
          total_commits: number;
        }>(`/compare/${previous.headSha}...${pull.head.sha}?per_page=1&page=1`);
        const files = comparison.files ?? [];
        return {
          untrusted: true,
          priorReviewedCommit: previous.headSha,
          reviewedCommit: pull.head.sha,
          status: comparison.status,
          totalCommits: comparison.total_commits,
          items: files.filter(
            (file) =>
              !githubReviewPathIsExcluded(file.filename, source.policy) &&
              !githubReviewPathIsExcluded(
                file.previous_filename ?? file.filename,
                source.policy,
              ),
          ),
          potentiallyTruncated: files.length >= 300,
          guidance:
            "GitHub limits comparison files to 300. This delta is supporting context; read all current PR files before claiming complete coverage. Force pushes can change ancestry.",
        };
      }
      const route =
        parsed.section === "comments"
          ? `/issues/${source.number}/comments`
          : `/pulls/${source.number}/${parsed.section}`;
      const rows = await api.request<Array<Record<string, unknown>>>(
        `${route}?per_page=100&page=${parsed.page}`,
      );
      return {
        untrusted: true,
        items:
          parsed.section === "files"
            ? rows.filter(
                (file) =>
                  !githubReviewPathIsExcluded(
                    String(file.filename),
                    source.policy,
                  ) &&
                  !githubReviewPathIsExcluded(
                    String(file.previous_filename ?? file.filename),
                    source.policy,
                  ),
              )
            : rows,
        hasMore: rows.length === 100,
        page: parsed.page,
        reviewedCommit: pull.head.sha,
      };
    }
    if (name === "read_file") {
      const parsed = z
        .object({
          path: z.string().min(1).max(1024),
          revision: z.enum(["head", "base"]),
        })
        .strict()
        .parse(input);
      if (
        parsed.path.startsWith("/") ||
        parsed.path.split("/").includes("..") ||
        parsed.path.includes("\\") ||
        githubReviewPathIsExcluded(parsed.path, source.policy)
      )
        throw forbidden("This path is excluded from the review");
      const result = await api.request<Record<string, unknown>>(
        `/contents/${parsed.path.split("/").map(encodeURIComponent).join("/")}?ref=${parsed.revision === "head" ? pull.head.sha : pull.base.sha}`,
      );
      // Provider URLs can contain credentials or direct download capabilities.
      return {
        untrusted: true,
        path: parsed.path,
        encoding: result.encoding,
        content: result.content,
        sha: result.sha,
        size: result.size,
      };
    }
    if (name === "submit_review") {
      const review = await reviewForHead(source, pull);
      const assessment = validateGitHubReviewAssessment(input, pull.head.sha, {
        ...review.policySnapshot,
        ignoredPaths: [
          ...review.policySnapshot.ignoredPaths,
          ...source.policy.ignoredPaths,
        ],
      });
      const files: File[] = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await api.request<File[]>(
          `/pulls/${source.number}/files?per_page=100&page=${page}`,
        );
        files.push(...batch);
        if (batch.length < 100) break;
        if (page === 30 && assessment.complete)
          throw conflict(
            "GitHub's file listing was truncated. Submit an incomplete review.",
          );
      }
      const permittedFiles = files.filter(
        (f) =>
          !githubReviewPathIsExcluded(f.filename, source.policy) &&
          !githubReviewPathIsExcluded(
            f.previous_filename ?? f.filename,
            source.policy,
          ),
      );
      const paths = new Set(permittedFiles.map((f) => f.filename));
      const byPath = new Map(
        permittedFiles.map((file) => [file.filename, file]),
      );
      if (
        assessment.findings.some(
          (finding) =>
            !githubReviewLineIsInPatch(
              byPath.get(finding.path)?.patch,
              finding.line,
              finding.side,
            ),
        )
      )
        throw conflict(
          "Each inline finding must identify a line and side in GitHub's current diff. Move findings outside the available diff into the summary.",
        );
      if (
        assessment.findings.some((f) => !paths.has(f.path)) ||
        assessment.coverage.reviewedPaths.some((path) => !paths.has(path))
      )
        throw conflict(
          "Assessment coverage and findings must refer to this PR's allowed changed files",
        );
      if (
        assessment.complete &&
        (assessment.coverage.omittedPaths.some((path) => paths.has(path)) ||
          permittedFiles.some(
            (file) =>
              !assessment.coverage.reviewedPaths.includes(file.filename),
          ))
      )
        throw conflict(
          "A complete assessment must cover every non-excluded changed file",
        );
      // Commit the immutable assessment and its publication together. A restart
      // must never leave a stored result with no durable publication intent.
      const actionId = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(chatGitHubReviews)
          .where(eq(chatGitHubReviews.id, review.id))
          .for("update");
        if (
          !current ||
          (current.assessment && hash(current.assessment) !== hash(assessment))
        )
          throw conflict(
            "This run already submitted its assessment. Start another review to revise it.",
          );
        await tx
          .update(chatGitHubReviews)
          .set({
            assessment,
            conclusion: githubReviewConclusion(
              assessment,
              review.policySnapshot.ratingThreshold,
            ),
            state: assessment.complete ? "completed" : "incomplete",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatGitHubReviews.id, review.id),
              eq(chatGitHubReviews.companyId, session.companyId),
            ),
          );
        return stage(
          source,
          "assessment",
          { reviewId: review.id, reviewedCommit: pull.head.sha },
          review.id,
          invocationId,
          name,
          input,
          tx,
        );
      });
      await processPublication(actionId);
      return {
        reviewId: review.id,
        ...(await receipt(actionId)),
        score: assessment.score,
        conclusion: githubReviewConclusion(
          assessment,
          review.policySnapshot.ratingThreshold,
        ),
      };
    }
    if (name === "formal_review") {
      const parsed = formalSchema.parse(input);
      if (parsed.reviewedCommit !== pull.head.sha)
        throw conflict("The PR head changed. Review the new commits first.");
      assertFormalPermission(source.policy, parsed.event);
      const [assessed] = await db
        .select()
        .from(chatGitHubReviews)
        .where(
          and(
            eq(chatGitHubReviews.endpointId, source.endpoint.id),
            eq(chatGitHubReviews.issueId, source.issue.id),
            eq(chatGitHubReviews.runId, source.run.id),
            eq(chatGitHubReviews.headSha, pull.head.sha),
            eq(chatGitHubReviews.state, "completed"),
          ),
        );
      if (!assessed?.assessment?.complete)
        throw conflict("Submit a complete assessment before a formal review");
      const actionId = await stage(
        source,
        "formal_review",
        parsed,
        parsed.idempotencyKey,
        invocationId,
        name,
        input,
      );
      await processPublication(actionId);
      return receipt(actionId);
    }
    throw notFound("Unknown GitHub bot tool");
  }
  function assertFormalPermission(
    policy: GitHubReviewPolicy,
    event: "APPROVE" | "REQUEST_CHANGES",
  ) {
    if (
      !(event === "APPROVE" ? policy.allowApprove : policy.allowRequestChanges)
    )
      throw forbidden(`Formal ${event} reviews are disabled for this bot`);
  }
  async function assertPublicationAuthority(
    source: Awaited<ReturnType<typeof scope>>,
    action: typeof chatActions.$inferSelect,
  ) {
    if (
      (source.endpoint.setup as { runtimeGeneration?: number })
        .runtimeGeneration !== action.payload.runtimeGeneration &&
      !(
        (source.endpoint.setup as { runtimeGeneration?: number })
          .runtimeGeneration === undefined &&
        action.payload.runtimeGeneration === 0
      )
    )
      throw forbidden(
        "The bot connection changed after this operation was requested",
      );
    const toolName = String(action.payload.toolName);
    const tool = (
      await githubBotToolsForSession(db, {
        companyId: source.endpoint.companyId,
        agentId: source.agent.id,
        issueId: source.issue.id,
        runId: source.run.id,
      })
    ).find(
      (tool) =>
        tool.connectionId === source.endpoint.connectionId &&
        tool.upstreamToolName === toolName,
    );
    if (!tool) throw forbidden("The bot tool is no longer available");
    const decision = await toolAccessPolicyService(db).decide({
      companyId: source.endpoint.companyId,
      actor: {
        actorType: "agent",
        actorId: source.agent.id,
        agentId: source.agent.id,
      },
      runContext: {
        heartbeatRunId: source.run.id,
        issueId: source.issue.id,
        projectId: source.issue.projectId,
      },
      request: {
        toolName: tool.name,
        applicationId: tool.applicationId,
        applicationKey: tool.applicationKey,
        connectionId: tool.connectionId,
        catalogEntryId: tool.catalogEntryId,
        providerType: tool.providerType,
        upstreamToolName: toolName,
        riskLevel: tool.risk,
        arguments: action.payload.parameters,
        sideEffecting: true,
      },
      consumeRateLimit: false,
    });
    if (decision.allowed) return;
    if (
      decision.decision === "require_approval" &&
      typeof action.payload.invocationId === "string"
    ) {
      const [invocation] = await db
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.id, action.payload.invocationId),
            eq(toolInvocations.companyId, source.endpoint.companyId),
            eq(toolInvocations.runId, source.run.id),
            eq(toolInvocations.agentId, source.agent.id),
            eq(toolInvocations.connectionId, source.endpoint.connectionId),
            eq(toolInvocations.toolName, tool.name),
          ),
        );
      if (
        invocation?.approvalState === "approved" &&
        ["executing", "completed"].includes(invocation.status)
      )
        return;
    }
    throw forbidden(decision.explanation);
  }
  async function processPublication(actionId: string) {
    // Existing chat outbox maintenance retries this action after a restart.
    // The row lock serializes dispatch; provider markers recover unknown writes.
    await db.transaction(async (tx) => {
      const [action] = await tx
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.id, actionId),
            eq(chatActions.kind, "github_review_publication"),
          ),
        )
        .for("update", { skipLocked: true });
      if (
        !action ||
        action.status === "processed" ||
        action.status === "cancelled"
      )
        return;
      const session = action.payload.session as Session;
      if (!session || session.companyId !== action.companyId)
        throw forbidden("Invalid GitHub publication binding");
      try {
        const source = await scope(session, true);
        if (
          source.endpoint.id !== action.endpointId ||
          source.conversation.id !== action.conversationId ||
          source.delivery.id !== action.deliveryId
        )
          throw forbidden("GitHub publication context changed");
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`github-publish:${source.endpoint.id}:${source.repositoryId}:${source.number}`}, 0))`,
        );
        await assertPublicationAuthority(source, action);
        const api = await client(source);
        const publicationMarker = marker(
          "publication",
          action.providerActionId,
        );
        const findByMarker = async (route: string, bodyMarker: string) => {
          for (let page = 1; page <= 100; page++) {
            const rows = await api.request<
              Array<{
                id: number;
                body?: string;
                html_url: string;
                user?: { login?: string };
              }>
            >(`${route}?per_page=100&page=${page}`);
            const found = rows.find(
              (row) =>
                row.body?.includes(bodyMarker) &&
                row.user?.login === source.endpoint.botUsername,
            );
            if (found) return found;
            if (rows.length < 100) return null;
          }
          throw conflict(
            "GitHub history is too large to safely resolve a publication retry",
          );
        };
        const currentHead = async (expected: string) => {
          const currentSource = await scope(session, true);
          await assertPublicationAuthority(currentSource, action);
          if (action.payload.operation === "formal_review")
            assertFormalPermission(
              currentSource.policy,
              action.payload.event as "APPROVE" | "REQUEST_CHANGES",
            );
          const [newer] = await tx
            .select({ id: chatGitHubReviews.id })
            .from(chatGitHubReviews)
            .where(
              and(
                eq(chatGitHubReviews.endpointId, source.endpoint.id),
                eq(chatGitHubReviews.repositoryId, source.repositoryId),
                eq(chatGitHubReviews.pullNumber, source.number),
                gt(chatGitHubReviews.createdAt, source.run.createdAt),
                sql`${chatGitHubReviews.runId} is distinct from ${source.run.id}`,
                sql`${chatGitHubReviews.assessment} is not null`,
              ),
            )
            .limit(1);
          if (newer) throw conflict("github_review_superseded");
          const current = await api.request<Pull>(`/pulls/${source.number}`);
          if (current.head.sha !== expected)
            throw conflict("github_review_superseded");
          return currentSource;
        };
        const operation = action.payload.operation;
        let receipt: Record<string, unknown>;
        if (operation === "comment") {
          const body = `${projectSafeChatPublicationText(String(action.payload.body))}\n\n${publicationMarker}`;
          const route = source.replyId
            ? `/pulls/${source.number}/comments`
            : `/issues/${source.number}/comments`;
          const prior = await findByMarker(route, publicationMarker);
          await assertPublicationAuthority(await scope(session, true), action);
          const posted =
            prior ??
            (await api.request<{ id: number; html_url: string }>(
              source.replyId
                ? `/pulls/${source.number}/comments/${source.replyId}/replies`
                : route,
              { method: "POST", body: { body } },
            ));
          receipt = { id: String(posted.id), url: posted.html_url };
        } else if (operation === "formal_review") {
          const parsed = formalSchema.parse({
            body: action.payload.body,
            event: action.payload.event,
            reviewedCommit: action.payload.reviewedCommit,
            idempotencyKey: action.payload.idempotencyKey,
          });
          assertFormalPermission(source.policy, parsed.event);
          await currentHead(parsed.reviewedCommit);
          const prior = await findByMarker(
            `/pulls/${source.number}/reviews`,
            publicationMarker,
          );
          const posted =
            prior ??
            (await api.request<{ id: number; html_url: string }>(
              `/pulls/${source.number}/reviews`,
              {
                method: "POST",
                body: {
                  commit_id: parsed.reviewedCommit,
                  event: parsed.event,
                  body: `${projectSafeChatPublicationText(parsed.body)}\n\n${publicationMarker}`,
                },
              },
            ));
          receipt = { id: String(posted.id), url: posted.html_url };
        } else if (operation === "assessment") {
          const [review] = await tx
            .select()
            .from(chatGitHubReviews)
            .where(
              and(
                eq(chatGitHubReviews.id, String(action.payload.reviewId)),
                eq(chatGitHubReviews.companyId, action.companyId),
                eq(chatGitHubReviews.endpointId, action.endpointId),
                eq(chatGitHubReviews.runId, session.runId!),
              ),
            )
            .for("update");
          if (!review?.assessment)
            throw conflict("Review assessment is unavailable");
          await currentHead(review.headSha);
          const assessment = validateGitHubReviewAssessment(
            review.assessment,
            review.headSha,
            {
              ...review.policySnapshot,
              ignoredPaths: [
                ...review.policySnapshot.ignoredPaths,
                ...source.policy.ignoredPaths,
              ],
            },
          );
          const conclusion = githubReviewConclusion(
            assessment,
            review.policySnapshot.ratingThreshold,
          );
          const origin = runtimePublicOrigin();
          const taskLink = origin
            ? `[${source.issue.identifier}](${origin}/issues/${source.issue.id})`
            : source.issue.identifier;
          const historyLink = origin
            ? ` · [Review history](${origin}/apps/chat/${source.endpoint.id}/reviews)`
            : "";
          const summary = projectSafeChatPublicationText(
            `## Paperclip Review — ${assessment.complete ? `${assessment.score}/5` : "Incomplete"}\n\n${assessment.summary}\n\n${assessment.rationale}\n\nReviewed commit: \`${review.headSha}\`\n\nCoverage: ${assessment.coverage.reviewedPaths.length} files.\n${assessment.coverage.limitations.join("\n")}\n\nTask: ${taskLink} · Run: ${source.run.id}${historyLink}`,
          );
          const summaryMarker = marker(
            "review",
            `${source.endpoint.id}:${source.repositoryId}:${source.number}`,
          );
          let summaryReceipt: { id: number; html_url: string } | null = null;
          if (source.policy.publishSummary) {
            const previous = await findByMarker(
              `/issues/${source.number}/comments`,
              summaryMarker,
            );
            const currentSummarySource = await currentHead(review.headSha);
            if (!currentSummarySource.policy.publishSummary)
              throw forbidden("Summary publication is disabled");
            summaryReceipt = await api.request(
              previous
                ? `/issues/comments/${previous.id}`
                : `/issues/${source.number}/comments`,
              {
                method: previous ? "PATCH" : "POST",
                body: { body: `${summary}\n\n${summaryMarker}` },
              },
            );
          }
          const severity = { info: 0, warning: 1, error: 2 };
          const receipts = { ...review.publicationReceipts };
          if (source.policy.publishInline)
            for (const finding of assessment.findings) {
              if (
                severity[finding.severity] <
                severity[source.policy.minimumCommentSeverity]
              )
                continue;
              const key = hash({
                key: finding.key,
                path: finding.path,
                line: finding.line,
                side: finding.side,
              });
              const findingMarker = marker(
                "finding",
                `${source.endpoint.id}:${source.repositoryId}:${source.number}:${key}`,
              );
              const prior = await findByMarker(
                `/pulls/${source.number}/comments`,
                findingMarker,
              );
              const currentFindingSource = await currentHead(review.headSha);
              if (
                !currentFindingSource.policy.publishInline ||
                severity[finding.severity] <
                  severity[currentFindingSource.policy.minimumCommentSeverity]
              )
                continue;
              if (
                githubReviewPathIsExcluded(
                  finding.path,
                  currentFindingSource.policy,
                )
              )
                throw forbidden("Finding path is now excluded");
              const posted =
                prior ??
                (await api.request<{ id: number; html_url: string }>(
                  `/pulls/${source.number}/comments`,
                  {
                    method: "POST",
                    body: {
                      body: `**${finding.severity} · ${finding.category}**\n\n${projectSafeChatPublicationText(finding.body)}\n\n${findingMarker}`,
                      commit_id: review.headSha,
                      path: finding.path,
                      line: finding.line,
                      side: finding.side,
                    },
                  },
                ));
              receipts[key] = {
                id: String(posted.id),
                url: posted.html_url,
                digest: hash(finding),
              };
            }
          await currentHead(review.headSha);
          const checks = await api.request<{
            check_runs: Array<{
              id: number;
              external_id?: string;
              app?: { id?: number };
            }>;
          }>(
            `/commits/${review.headSha}/check-runs?check_name=Paperclip%20Review&per_page=100`,
          );
          const check = checks.check_runs.find(
            (item) =>
              item.external_id ===
                `${source.endpoint.id}:${source.number}:${review.headSha}` &&
              String(item.app?.id) === source.endpoint.botExternalId,
          );
          await currentHead(review.headSha);
          const postedCheck = await api.request<{
            id: number;
            html_url: string;
          }>(check ? `/check-runs/${check.id}` : "/check-runs", {
            method: check ? "PATCH" : "POST",
            body: {
              name: "Paperclip Review",
              head_sha: review.headSha,
              external_id: `${source.endpoint.id}:${source.number}:${review.headSha}`,
              status: "completed",
              conclusion,
              output: {
                title: assessment.complete
                  ? `${assessment.score}/5`
                  : "Incomplete review",
                summary,
              },
            },
          });
          await tx
            .update(chatGitHubReviews)
            .set({
              conclusion,
              checkId: String(postedCheck.id),
              checkUrl: postedCheck.html_url,
              summaryId: summaryReceipt
                ? String(summaryReceipt.id)
                : review.summaryId,
              summaryUrl: summaryReceipt?.html_url ?? review.summaryUrl,
              publicationReceipts: receipts,
              updatedAt: new Date(),
            })
            .where(eq(chatGitHubReviews.id, review.id));
          receipt = {
            reviewId: review.id,
            checkUrl: postedCheck.html_url,
            summaryUrl: summaryReceipt?.html_url ?? null,
          };
        } else throw forbidden("Unknown GitHub publication");
        await tx
          .update(chatActions)
          .set({ status: "processed", result: receipt, updatedAt: new Date() })
          .where(eq(chatActions.id, action.id));
        await logActivity(tx as unknown as Db, {
          companyId: action.companyId,
          actorType: "agent",
          actorId: source.agent.id,
          action: "chat_github.published",
          entityType: "issue",
          entityId: source.issue.id,
          runId: source.run.id,
          details: { actionId: action.id, operation, ...receipt },
        });
      } catch (error) {
        const attempts = Number(action.result?.attempts ?? 0) + 1;
        const denied = error instanceof HttpError && error.status === 403;
        const superseded =
          error instanceof Error &&
          error.message === "github_review_superseded";
        if (superseded && typeof action.payload.reviewId === "string")
          await tx
            .update(chatGitHubReviews)
            .set({ state: "superseded", updatedAt: new Date() })
            .where(
              and(
                eq(chatGitHubReviews.id, action.payload.reviewId),
                eq(chatGitHubReviews.companyId, action.companyId),
              ),
            );
        await tx
          .update(chatActions)
          .set({
            status: superseded || denied ? "cancelled" : "failed",
            result: {
              attempts,
              retryable: !superseded && !denied && attempts < 8,
              retryAt: new Date(
                Date.now() + Math.min(300000, 1000 * 2 ** attempts),
              ).toISOString(),
              code: superseded
                ? "stale_head"
                : denied
                  ? "authorization_changed"
                  : "publication_failed",
            },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, action.id));
      }
    });
  }
  async function processPending(limit = 10) {
    const rows = await db
      .select({
        id: chatActions.id,
        status: chatActions.status,
        result: chatActions.result,
      })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "github_review_publication"),
          or(
            eq(chatActions.status, "received"),
            and(
              eq(chatActions.status, "failed"),
              sql`${chatActions.result}->>'retryable' = 'true'`,
              sql`(${chatActions.result}->>'retryAt')::timestamptz <= now()`,
            ),
          ),
        ),
      )
      .orderBy(chatActions.createdAt)
      .limit(limit);
    for (const row of rows)
      if (
        row.status === "received" ||
        (row.result?.retryable === true &&
          Date.parse(String(row.result.retryAt)) <= Date.now())
      )
        await processPublication(row.id);
    return rows.length;
  }
  return { execute, processPending, scope };
}
