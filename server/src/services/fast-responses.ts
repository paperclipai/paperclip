import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  agents,
  toolConnections,
  assets,
  issueAttachments,
  projects,
  authUsers,
  budgetPolicies,
  budgetReservations,
  companies,
  companyFastResponses,
  companyMemberships,
  companySecrets,
  costEvents,
  fastResponseRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  chatPublications,
  type Db,
} from "@paperclipai/db";
import {
  aiConnectionCatalogSlug,
  aiConnectionMetadataSchema,
  centsToUnits,
  unitsToCents,
  updateFastResponseSchema,
  FAST_RESPONSE_DEADLINE_MS,
  type AiProvider,
  type FastResponseSettings,
  type FastResponseHistoryEntry,
  type UpdateFastResponse,
  type FastResponseTestResult,
} from "@paperclipai/shared";
import { aiConnectionService } from "./ai-connections.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./recovery/pause-hold-guard.js";
import { accessService } from "./access.js";
import type { AuthorizationActor } from "./authorization.js";
import { forbidden, unprocessable } from "../errors.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import {
  budgetPoliciesForRun,
  budgetService,
  budgetServiceInTransaction,
  computeObservedSpend,
  type BudgetServiceHooks,
} from "./budgets.js";
import { createCostEventInTransaction } from "./costs.js";
import {
  notifyDeliveryWork,
  DELIVERY_QUEUES,
} from "./delivery-work-notifications.js";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import {
  fastResponsePrompt,
  fastResponseReceipt,
  runFastResponseProvider,
  type FastResponseOutcome,
  type FastResponsePromptInput,
} from "./fast-response-provider.js";

type Request = typeof fastResponseRequests.$inferSelect;
export type FastResponseSource = Pick<
  Request,
  "companyId" | "issueId" | "agentId" | "responsibleUserId"
> &
  Partial<
    Pick<
      Request,
      | "sourceCommentId"
      | "endpointId"
      | "conversationId"
      | "deliveryId"
      | "sponsored"
      | "sessionGeneration"
    >
  > & { sourceKey: string; acceptedAt: Date };
export type FastResponseExternalAuthorization = (
  tx: Db,
  request: Request,
) => Promise<FastResponsePromptInput>;

/** Board chat streams without a heartbeat run; fence its receipt when real text begins. */
export async function supersedeFastResponse(
  db: Db,
  companyId: string,
  sourceCommentId: string,
) {
  await db
    .update(fastResponseRequests)
    .set({
      errorCode: "real_reply_started",
      publicationStatus: "suppressed",
      status: sql`case when ${fastResponseRequests.status} = 'pending' then 'skipped' else ${fastResponseRequests.status} end`,
    })
    .where(
      and(
        eq(fastResponseRequests.companyId, companyId),
        eq(fastResponseRequests.sourceCommentId, sourceCommentId),
        isNull(fastResponseRequests.commentId),
        inArray(fastResponseRequests.status, ["pending", "running"]),
      ),
    );
}

/** Called only at an authenticated, accepted human-turn boundary, on its transaction. */
export async function enqueueFastResponse(tx: Db, source: FastResponseSource) {
  const [config] = await tx
    .select({ enabled: companyFastResponses.enabled })
    .from(companyFastResponses)
    .where(eq(companyFastResponses.companyId, source.companyId));
  if (
    !config?.enabled ||
    !source.issueId ||
    (!source.agentId && !source.sourceKey.startsWith("board:"))
  )
    return;
  const [comment] = source.sourceCommentId
    ? await tx
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, source.companyId),
            eq(issueComments.id, source.sourceCommentId),
          ),
        )
    : [];
  if (
    comment &&
    (comment.origin === "fast_response" ||
      /^\s*\//.test(comment.body) ||
      comment.deletedAt)
  )
    return;
  if (source.acceptedAt.getTime() + FAST_RESPONSE_DEADLINE_MS <= Date.now())
    return;
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.fastResponse);
  await tx
    .insert(fastResponseRequests)
    .values({
      ...source,
      expiresAt: new Date(
        source.acceptedAt.getTime() + FAST_RESPONSE_DEADLINE_MS,
      ),
    })
    .onConflictDoNothing();
}

/** Shared with external transport admission. Caller already checks destination authority. */
export async function fastResponseSourceCurrent(tx: Db, request: Request) {
  if (!request.issueId || request.expiresAt.getTime() <= Date.now())
    return false;
  const [company] = await tx
    .select({ status: companies.status })
    .from(companies)
    .where(eq(companies.id, request.companyId));
  const [agent] = request.agentId
    ? await tx
        .select({ status: agents.status })
        .from(agents)
        .where(
          and(
            eq(agents.id, request.agentId),
            eq(agents.companyId, request.companyId),
          ),
        )
    : [];
  if (
    company?.status !== "active" ||
    (request.agentId &&
      (!agent || ["paused", "terminated"].includes(agent.status)))
  )
    return false;
  const [issue] = await tx
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.id, request.issueId),
        eq(issues.companyId, request.companyId),
      ),
    )
    .for("update");
  if (
    !issue ||
    issue.hiddenAt ||
    (request.agentId && issue.assigneeAgentId !== request.agentId) ||
    ["done", "cancelled"].includes(issue.status) ||
    (request.sessionGeneration !== null &&
      issue.conversationSessionGeneration !== request.sessionGeneration)
  )
    return false;
  if (
    await isAutomaticRecoverySuppressedByPauseHold(
      tx,
      request.companyId,
      request.issueId,
    )
  )
    return false;
  const [source] = request.sourceCommentId
    ? await tx
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, request.companyId),
            eq(issueComments.id, request.sourceCommentId),
            isNull(issueComments.deletedAt),
          ),
        )
    : [];
  if (
    request.sourceCommentId &&
    (!source || source.updatedAt.getTime() > request.acceptedAt.getTime() + 10)
  )
    return false;
  const [answer] = await tx
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, request.companyId),
        eq(issueComments.issueId, request.issueId),
        eq(issueComments.origin, "comment"),
        isNull(issueComments.deletedAt),
        gt(issueComments.createdAt, source?.createdAt ?? request.acceptedAt),
        request.agentId
          ? eq(issueComments.authorAgentId, request.agentId)
          : eq(issueComments.authorUserId, "board-concierge"),
      ),
    )
    .limit(1);
  const [stopped] = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, request.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${request.issueId}`,
        inArray(heartbeatRuns.status, ["cancelled", "failed", "succeeded"]),
        request.sourceCommentId
          ? sql`coalesce(${heartbeatRuns.contextSnapshot}->>'wakeCommentId', ${heartbeatRuns.contextSnapshot}->>'commentId') = ${request.sourceCommentId}`
          : gte(heartbeatRuns.createdAt, request.acceptedAt),
      ),
    )
    .limit(1);
  const [streamed] = await tx
    .select({ id: heartbeatRunEvents.id })
    .from(heartbeatRunEvents)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunEvents.runId))
    .where(
      and(
        eq(heartbeatRunEvents.companyId, request.companyId),
        gt(heartbeatRunEvents.createdAt, request.acceptedAt),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${request.issueId}`,
        inArray(heartbeatRunEvents.eventType, ["item.delta", "item.completed"]),
        sql`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind' = 'agentMessage'`,
        sql`length(coalesce(${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'text', '')) > 0`,
      ),
    )
    .limit(1);
  return !answer && !stopped && !streamed;
}

export function fastResponseService(
  db: Db,
  options: {
    provider?: typeof runFastResponseProvider;
    budgetHooks?: BudgetServiceHooks;
    authorizeExternal?: FastResponseExternalAuthorization;
    publishExternal?: (
      tx: Db,
      request: Request,
      commentId: string,
      text: string,
    ) => Promise<boolean>;
  } = {},
) {
  const providerCall = options.provider ?? runFastResponseProvider;
  async function settings(companyId: string): Promise<FastResponseSettings> {
    const [row] = await db
      .select()
      .from(companyFastResponses)
      .where(eq(companyFastResponses.companyId, companyId));
    return row
      ? { ...row, provider: row.provider as AiProvider }
      : {
          companyId,
          enabled: false,
          connectionId: null,
          grantId: null,
          provider: null,
          model: null,
          allowSponsored: true,
        };
  }
  async function choices(companyId: string, userId: string) {
    return (await aiConnectionService(db).list(companyId, userId)).filter(
      (c) => c.ownership === "shared" && c.method === "api_key",
    );
  }
  async function configure(
    companyId: string,
    userId: string,
    input: UpdateFastResponse,
  ) {
    const data = updateFastResponseSchema.parse(input);
    return withAccountingTransaction(
      db,
      companyId,
      async (tx, publications) => {
        const [previous] = await tx
          .select()
          .from(companyFastResponses)
          .where(eq(companyFastResponses.companyId, companyId));
        const disabling =
          !data.enabled &&
          previous?.connectionId === data.connectionId &&
          previous?.grantId === data.grantId;
        const connection =
          !disabling && data.connectionId && data.grantId
            ? await aiConnectionService(tx).selectFastResponse({
                companyId,
                userId,
                connectionId: data.connectionId,
                grantId: data.grantId,
              })
            : null;
        const values = {
          ...data,
          companyId,
          provider: disabling
            ? previous.provider
            : (connection?.provider ?? null),
          updatedAt: new Date(),
        };
        await tx
          .insert(companyFastResponses)
          .values(values)
          .onConflictDoUpdate({
            target: companyFastResponses.companyId,
            set: values,
          });
        await logActivity(
          tx,
          {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "fast_response.configured",
            entityType: "company",
            entityId: companyId,
            details: data,
          },
          publications,
        );
        return { ...values, provider: values.provider as AiProvider | null };
      },
    );
  }
  async function resolve(
    tx: Db,
    request: Pick<
      Request,
      | "companyId"
      | "issueId"
      | "responsibleUserId"
      | "agentId"
      | "sponsored"
      | "endpointId"
    > &
      Partial<Pick<Request, "connectionId" | "grantId" | "model">>,
  ) {
    const [config] = await tx
      .select()
      .from(companyFastResponses)
      .where(eq(companyFastResponses.companyId, request.companyId));
    if (
      !config?.enabled ||
      !config.connectionId ||
      !config.grantId ||
      !config.model
    )
      throw unprocessable("disabled");
    if (
      request.connectionId &&
      (request.connectionId !== config.connectionId ||
        request.grantId !== config.grantId ||
        request.model !== config.model)
    )
      throw forbidden("configuration_changed");
    if (
      request.sponsored &&
      (!config.allowSponsored ||
        request.responsibleUserId ||
        !request.endpointId)
    )
      throw forbidden("sponsorship_disabled");
    const memberships = request.responsibleUserId
      ? await tx
          .select({
            companyId: companyMemberships.companyId,
            membershipRole: companyMemberships.membershipRole,
            status: companyMemberships.status,
          })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, request.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, request.responsibleUserId),
            ),
          )
      : [];
    if (!request.sponsored && !request.responsibleUserId)
      throw forbidden("responsible_user_missing");
    const [issue] = request.issueId
      ? await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, request.companyId),
              eq(issues.id, request.issueId),
            ),
          )
      : [];
    if (request.issueId && !issue) throw forbidden();
    if (!request.sponsored && issue) {
      const actor: AuthorizationActor = {
        type: "board",
        userId: request.responsibleUserId!,
        source:
          request.responsibleUserId === "local-board"
            ? "local_implicit"
            : "session",
        companyIds: memberships.map((m) => m.companyId),
        memberships,
      };
      if (
        !(
          await accessService(tx).decide({
            actor,
            action: "issue:read",
            resource: {
              type: "issue",
              companyId: request.companyId,
              issueId: issue.id,
              projectId: issue.projectId,
              parentIssueId: issue.parentId,
              assigneeAgentId: issue.assigneeAgentId,
              assigneeUserId: issue.assigneeUserId,
              status: issue.status,
            },
          })
        ).allowed
      )
        throw forbidden();
    }
    const connection = await aiConnectionService(tx).selectFastResponse({
      companyId: request.companyId,
      connectionId: config.connectionId,
      grantId: config.grantId,
      userId: request.responsibleUserId,
      agentId: request.agentId,
      sponsoredBackground: request.sponsored,
    });
    return { config, connection, issue };
  }
  async function availability(companyId: string, userId: string) {
    try {
      await resolve(db, {
        companyId,
        responsibleUserId: userId,
        issueId: null,
        agentId: null,
        sponsored: false,
        endpointId: null,
      });
      return { available: true as const };
    } catch {
      return { available: false as const, reason: "connection_unavailable" };
    }
  }
  async function skip(request: Request, reason: string) {
    await db
      .update(fastResponseRequests)
      .set({
        status: "skipped",
        publicationStatus: "suppressed",
        errorCode: reason,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(fastResponseRequests.id, request.id),
          eq(fastResponseRequests.status, "pending"),
        ),
      );
  }
  async function settle(request: Request, outcome: FastResponseOutcome) {
    await withAccountingTransaction(
      db,
      request.companyId,
      async (tx, publications) => {
        const [current] = await tx
          .select()
          .from(fastResponseRequests)
          .where(eq(fastResponseRequests.id, request.id))
          .for("update");
        if (!current || current.status !== "running") return;
        const receipt = outcome.receipt;
        const links: {
          agentId: string | null;
          issueId: string | null;
          projectId: string | null;
        } = { agentId: null, issueId: null, projectId: null };
        for (const [key, table] of [
          ["agentId", agents],
          ["issueId", issues],
          ["projectId", projects],
        ] as const) {
          const id = request[key];
          if (!id) continue;
          const [row] = await tx
            .select({ id: table.id })
            .from(table)
            .where(
              and(eq(table.id, id), eq(table.companyId, request.companyId)),
            )
            .for("key share");
          if (row) links[key] = row.id;
        }
        const event = await createCostEventInTransaction(
          tx,
          request.companyId,
          {
            usageKind: "fast_response",
            responsibleUserId: request.responsibleUserId,
            ...links,
            heartbeatRunId: null,
            idempotencyKey: `fast-response:${request.id}`,
            provider: request.provider!,
            biller: request.provider!,
            model: request.model!,
            billingType: "metered_api",
            costStatus: receipt.costStatus,
            inputTokens: receipt.inputTokens ?? 0,
            outputTokens: receipt.outputTokens ?? 0,
            costCents: receipt.costCents ?? "0",
            providerRequestId: receipt.providerRequestId,
            pricingProvenance: receipt.pricingProvenance,
            occurredAt: request.startedAt!,
          },
          publications,
          {
            actorType: request.responsibleUserId ? "user" : "system",
            actorId: request.responsibleUserId ?? "paperclip-fast-response",
          },
        );
        const finishedAt = new Date();
        await tx
          .update(fastResponseRequests)
          .set({
            status: outcome.text
              ? "succeeded"
              : receipt.costStatus === "unpriced"
                ? "unknown"
                : "failed",
            errorCode: outcome.errorCode ?? null,
            costEventId: event.id,
            providerRequestId: receipt.providerRequestId,
            inputTokens: receipt.inputTokens,
            outputTokens: receipt.outputTokens,
            finishedAt,
            durationMs: finishedAt.getTime() - request.acceptedAt.getTime(),
            ...(outcome.text ? {} : { publicationStatus: "suppressed" }),
          })
          .where(eq(fastResponseRequests.id, request.id));
        if (receipt.costStatus !== "unpriced")
          await tx
            .update(budgetReservations)
            .set({
              state: outcome.noProviderWork ? "released" : "settled",
              settledAt: finishedAt,
            })
            .where(
              and(
                eq(budgetReservations.companyId, request.companyId),
                eq(budgetReservations.fastResponseRequestId, request.id),
                eq(budgetReservations.state, "held"),
              ),
            );
      },
    );
    await budgetService(db, options.budgetHooks).deliverPendingEnforcement(
      request.companyId,
    );
  }
  async function process(
    request: Request,
    signal?: AbortSignal,
  ): Promise<FastResponseTestResult> {
    let selected: Awaited<ReturnType<typeof resolve>>,
      credential: string,
      prompt: string;
    let secretId: string | undefined,
      secret: typeof companySecrets.$inferSelect | undefined;
    try {
      selected = await resolve(db, request);
      const [agent] = request.agentId
        ? await db
            .select({ name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.companyId, request.companyId),
                eq(agents.id, request.agentId),
              ),
            )
        : [];
      if (request.endpointId) {
        if (!options.authorizeExternal) throw forbidden();
        const context = await db.transaction((tx) =>
          options.authorizeExternal!(tx as unknown as Db, request),
        );
        prompt = fastResponsePrompt(context);
      } else if (request.issueId) {
        const [source] = request.sourceCommentId
          ? await db
              .select()
              .from(issueComments)
              .where(
                and(
                  eq(issueComments.companyId, request.companyId),
                  eq(issueComments.id, request.sourceCommentId),
                ),
              )
          : [];
        const recent = await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, request.companyId),
              eq(issueComments.issueId, request.issueId),
              isNull(issueComments.deletedAt),
              eq(issueComments.origin, "comment"),
              lt(
                issueComments.createdAt,
                source?.createdAt ?? request.acceptedAt,
              ),
            ),
          )
          .orderBy(desc(issueComments.createdAt))
          .limit(2);
        const attachments = request.sourceCommentId
          ? await db
              .select({
                name: assets.originalFilename,
                type: assets.contentType,
              })
              .from(issueAttachments)
              .innerJoin(
                assets,
                and(
                  eq(assets.id, issueAttachments.assetId),
                  eq(assets.companyId, request.companyId),
                ),
              )
              .where(
                and(
                  eq(issueAttachments.companyId, request.companyId),
                  eq(issueAttachments.issueCommentId, request.sourceCommentId),
                ),
              )
              .limit(5)
          : [];
        prompt = fastResponsePrompt({
          attachments: attachments.map((a) => `${a.name} (${a.type})`),
          agentName: agent?.name ?? "Board assistant",
          message:
            source?.body ??
            selected.issue?.description ??
            selected.issue?.title ??
            "",
          title: selected.issue?.title,
          recent: recent.reverse().map((c) => c.body),
          queued: Boolean(selected.issue?.executionRunId),
        });
      } else
        prompt = fastResponsePrompt({
          agentName: "Assistant",
          message: "Fix the border around the settings panel.",
        });
      secretId = selected.connection.grant.credentialSecretRefs.find(
        (r) => r.configPath === "ai.credential",
      )?.secretId;
      [secret] = secretId
        ? await db
            .select()
            .from(companySecrets)
            .where(
              and(
                eq(companySecrets.id, secretId),
                eq(companySecrets.companyId, request.companyId),
              ),
            )
        : [];
      credential = await aiConnectionService(db).credential(
        selected.connection,
        0,
        {
          responsibleUserId: request.responsibleUserId,
          actorType: request.responsibleUserId ? "user" : "system",
          actorId: request.responsibleUserId ?? "paperclip-fast-response",
          issueId: request.issueId,
        },
      );
    } catch {
      await skip(request, "connection_unavailable");
      return { status: "unavailable", reason: "connection_unavailable" };
    }
    const metadata = aiConnectionMetadataSchema.parse(
      selected.connection.connection.config.ai,
    );
    let admitted: Request | null = null;
    try {
      admitted = await withAccountingTransaction(
        db,
        request.companyId,
        async (tx) => {
          if (request.expiresAt.getTime() <= Date.now() || signal?.aborted)
            return null;
          const current = await resolve(tx, request);
          if (
            current.config.updatedAt.getTime() !==
              selected.config.updatedAt.getTime() ||
            current.connection.connection.updatedAt.getTime() !==
              selected.connection.connection.updatedAt.getTime() ||
            current.connection.grant.updatedAt.getTime() !==
              selected.connection.grant.updatedAt.getTime()
          )
            return null;
          if (secretId) {
            const [now] = await tx
              .select()
              .from(companySecrets)
              .where(eq(companySecrets.id, secretId))
              .for("share");
            if (
              !now ||
              now.status !== "active" ||
              now.latestVersion !== secret?.latestVersion
            )
              return null;
          }
          if (
            request.issueId &&
            !(await fastResponseSourceCurrent(tx, request))
          )
            return null;
          if (request.endpointId) await options.authorizeExternal!(tx, request);
          const [company] = await tx
            .select()
            .from(companies)
            .where(eq(companies.id, request.companyId));
          const [agent] = request.agentId
            ? await tx
                .select()
                .from(agents)
                .where(
                  and(
                    eq(agents.id, request.agentId),
                    eq(agents.companyId, request.companyId),
                  ),
                )
            : [];
          if (
            company?.status !== "active" ||
            (request.agentId &&
              (!agent || ["paused", "terminated"].includes(agent.status)))
          )
            return null;
          if (
            await budgetServiceInTransaction(tx, []).getInvocationBlock(
              request.companyId,
              request.agentId,
              { projectId: current.issue?.projectId },
            )
          )
            return null;
          const policies = await tx
            .select()
            .from(budgetPolicies)
            .where(
              and(
                eq(budgetPolicies.companyId, request.companyId),
                eq(budgetPolicies.isActive, true),
                eq(budgetPolicies.hardStopEnabled, true),
                eq(budgetPolicies.metric, "billed_cents"),
                sql`${budgetPolicies.amount} > 0`,
                budgetPoliciesForRun(
                  request.companyId,
                  request.agentId,
                  current.issue?.projectId ?? null,
                ),
              ),
            );
          const amount = policies.reduce((max, p) => {
            const n = centsToUnits(p.reservationCents);
            return n > max ? n : max;
          }, 0n);
          for (const policy of policies) {
            const [held] = await tx
              .select({
                total: sql<string>`coalesce(sum(${budgetReservations.amountCents}),0)::text`,
              })
              .from(budgetReservations)
              .where(
                and(
                  eq(budgetReservations.companyId, request.companyId),
                  eq(budgetReservations.state, "held"),
                  policy.scopeType === "agent"
                    ? eq(budgetReservations.agentId, request.agentId!)
                    : undefined,
                  policy.scopeType === "project"
                    ? eq(
                        budgetReservations.projectId,
                        current.issue!.projectId!,
                      )
                    : undefined,
                ),
              );
            const committed =
              centsToUnits(
                (await computeObservedSpend(tx, policy)).totalExact,
              ) + centsToUnits(held.total);
            if (
              committed >= centsToUnits(policy.amount) ||
              committed + amount > centsToUnits(policy.amount)
            )
              return null;
          }
          const [claimed] = await tx
            .update(fastResponseRequests)
            .set({
              status: "running",
              startedAt: new Date(),
              connectionId: current.config.connectionId,
              grantId: current.config.grantId,
              model: current.config.model,
              provider: aiConnectionCatalogSlug(
                current.connection.provider,
                metadata.routing,
              ),
              projectId: current.issue?.projectId ?? null,
            })
            .where(
              and(
                eq(fastResponseRequests.id, request.id),
                eq(fastResponseRequests.status, "pending"),
              ),
            )
            .returning();
          if (!claimed) return null;
          await tx
            .insert(budgetReservations)
            .values({
              companyId: request.companyId,
              fastResponseRequestId: request.id,
              agentId: request.agentId,
              projectId: current.issue?.projectId,
              amountCents: unitsToCents(amount),
              providerStartedAt: claimed.startedAt,
            });
          return claimed;
        },
      );
    } catch {
      /* An optional receipt must never fail the accepted turn. */
    }
    if (!admitted) {
      await skip(request, "not_admitted");
      return { status: "unavailable", reason: "not_admitted" };
    }
    const timeout = AbortSignal.timeout(
      Math.max(1, request.expiresAt.getTime() - Date.now()),
    );
    let outcome: FastResponseOutcome;
    try {
      outcome = await providerCall({
        metadata,
        credential,
        model: admitted.model!,
        prompt,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      outcome = {
        errorCode: "provider_failed",
        receipt: fastResponseReceipt(),
      };
    }
    // Commit the visible receipt first: accounting settlement must not spend its display deadline.
    if (outcome.text && request.issueId) {
      const text = outcome.text;
      try {
        const publications: ActivityPublication[] = [];
        await db.transaction(async (tx) => {
          if (!(await fastResponseSourceCurrent(tx as unknown as Db, request)))
            return;
          await resolve(tx as unknown as Db, admitted!);
          if (request.endpointId)
            await options.authorizeExternal!(tx as unknown as Db, request);
          const [locked] = await tx
            .select()
            .from(fastResponseRequests)
            .where(eq(fastResponseRequests.id, request.id))
            .for("update");
          if (
            !locked ||
            locked.commentId ||
            locked.status !== "running" ||
            locked.errorCode === "real_reply_started"
          )
            return;
          if (request.expiresAt.getTime() <= Date.now()) return;
          const safe = projectSafeChatPublication({
            classification: "external",
            source: "agent_comment",
            text,
          });
          const [source] = request.sourceCommentId
            ? await tx
                .select({ sourceTrust: issueComments.sourceTrust })
                .from(issueComments)
                .where(
                  and(
                    eq(issueComments.companyId, request.companyId),
                    eq(issueComments.id, request.sourceCommentId),
                  ),
                )
            : [];
          const [comment] = await tx
            .insert(issueComments)
            .values({
              companyId: request.companyId,
              issueId: request.issueId!,
              authorAgentId: request.agentId,
              authorUserId: request.agentId ? null : "board-concierge",
              authorType: request.agentId ? "agent" : "system",
              body: safe.text,
              sourceTrust: source?.sourceTrust ?? null,
              conversationSessionGeneration: request.sessionGeneration,
              origin: "fast_response",
              fastResponseRequestId: request.id,
            })
            .returning();
          if (
            request.endpointId &&
            request.conversationId &&
            !(await options.publishExternal?.(
              tx as unknown as Db,
              request,
              comment.id,
              safe.text,
            ))
          )
            await tx
              .insert(chatPublications)
              .values({
                companyId: request.companyId,
                issueId: request.issueId!,
                endpointId: request.endpointId,
                conversationId: request.conversationId,
                commentId: comment.id,
                idempotencyKey: `fast-response:${request.id}`,
                payload: safe,
              });
          await tx
            .update(fastResponseRequests)
            .set({
              commentId: comment.id,
              publicationStatus: request.endpointId ? "pending" : "published",
            })
            .where(eq(fastResponseRequests.id, request.id));
          await logActivity(
            tx as unknown as Db,
            {
              companyId: request.companyId,
              actorType: "system",
              actorId: "paperclip-fast-response",
              action: "issue.comment_added",
              entityType: "issue",
              entityId: request.issueId!,
              details: { commentId: comment.id, origin: "fast_response" },
            },
            publications,
          );
        });
        for (const publication of publications) publishActivity(publication);
      } catch {
        /* Never substitute an unsafe or obsolete acknowledgement. */
      }
    }
    await settle(admitted, outcome);
    await db
      .update(fastResponseRequests)
      .set({ publicationStatus: request.issueId ? "suppressed" : "test" })
      .where(
        and(
          eq(fastResponseRequests.id, request.id),
          isNull(fastResponseRequests.commentId),
        ),
      );
    return outcome.text
      ? {
          status: "succeeded",
          text: outcome.text,
          durationMs: Date.now() - request.acceptedAt.getTime(),
          invocationId: request.id,
          usage: outcome.receipt,
        }
      : {
          status: "failed",
          reason: outcome.errorCode ?? "provider_failed",
          invocationId: request.id,
        };
  }
  async function test(companyId: string, userId: string) {
    const now = new Date();
    const [request] = await db
      .insert(fastResponseRequests)
      .values({
        companyId,
        sourceKey: `test:${randomUUID()}`,
        responsibleUserId: userId,
        acceptedAt: now,
        expiresAt: new Date(now.getTime() + FAST_RESPONSE_DEADLINE_MS),
      })
      .returning();
    return process(request);
  }
  async function sweepPending(signal?: AbortSignal) {
    const stale = await db
      .select()
      .from(fastResponseRequests)
      .where(
        and(
          eq(fastResponseRequests.status, "running"),
          lt(fastResponseRequests.expiresAt, new Date(Date.now() - 30_000)),
        ),
      )
      .limit(50);
    for (const row of stale)
      await settle(row, {
        errorCode: "interrupted",
        receipt: fastResponseReceipt(),
      });
    await db
      .update(fastResponseRequests)
      .set({
        status: "skipped",
        publicationStatus: "suppressed",
        errorCode: "expired",
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(fastResponseRequests.status, "pending"),
          lte(fastResponseRequests.expiresAt, new Date()),
        ),
      );
    const pending = await db
      .select()
      .from(fastResponseRequests)
      .where(
        and(
          eq(fastResponseRequests.status, "pending"),
          sql`${fastResponseRequests.sourceKey} not like 'test:%'`,
          gt(fastResponseRequests.expiresAt, new Date()),
        ),
      )
      .orderBy(fastResponseRequests.acceptedAt)
      .limit(8);
    await Promise.allSettled(pending.map((row) => process(row, signal)));
  }
  async function hasPending() {
    const [row] = await db
      .select({ id: fastResponseRequests.id })
      .from(fastResponseRequests)
      .where(inArray(fastResponseRequests.status, ["pending", "running"]))
      .limit(1);
    return Boolean(row);
  }
  async function history(
    companyId: string,
    actor: AuthorizationActor,
    range: { from?: Date; to?: Date; limit?: number } = {},
  ): Promise<FastResponseHistoryEntry[]> {
    if (
      !(
        await accessService(db).decide({
          actor,
          action: "company_scope:read",
          resource: { type: "company", companyId },
        })
      ).allowed
    )
      throw forbidden();
    const rows = await db
      .select({
        request: fastResponseRequests,
        userName: authUsers.name,
        cost: costEvents,
        issue: issues,
        publicationState: chatPublications.state,
        connectionName: toolConnections.name,
      })
      .from(fastResponseRequests)
      .leftJoin(
        costEvents,
        and(
          eq(costEvents.companyId, companyId),
          eq(costEvents.id, fastResponseRequests.costEventId),
        ),
      )
      .leftJoin(
        authUsers,
        eq(authUsers.id, fastResponseRequests.responsibleUserId),
      )
      .leftJoin(
        toolConnections,
        and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.id, fastResponseRequests.connectionId),
        ),
      )
      .leftJoin(
        chatPublications,
        and(
          eq(chatPublications.companyId, companyId),
          eq(
            chatPublications.idempotencyKey,
            sql`'fast-response:' || ${fastResponseRequests.id}::text`,
          ),
        ),
      )
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          eq(issues.id, fastResponseRequests.issueId),
        ),
      )
      .where(
        and(
          eq(fastResponseRequests.companyId, companyId),
          range.from
            ? gte(fastResponseRequests.acceptedAt, range.from)
            : undefined,
          range.to ? lte(fastResponseRequests.acceptedAt, range.to) : undefined,
        ),
      )
      .orderBy(desc(fastResponseRequests.acceptedAt))
      .limit(Math.min(range.limit ?? 100, 500));
    return Promise.all(
      rows.map(
        async ({
          request: r,
          userName,
          cost,
          issue,
          publicationState,
          connectionName,
        }) => {
          const visible =
            issue &&
            (
              await accessService(db).decide({
                actor,
                action: "issue:read",
                resource: {
                  type: "issue",
                  companyId,
                  issueId: issue.id,
                  projectId: issue.projectId,
                  parentIssueId: issue.parentId,
                  assigneeAgentId: issue.assigneeAgentId,
                  assigneeUserId: issue.assigneeUserId,
                  status: issue.status,
                },
              })
            ).allowed;
          return {
            id: r.id,
            feature: r.sourceKey.startsWith("test:")
              ? "settings.test"
              : "message",
            actorType: r.sponsored ? "system" : "user",
            responsibleUserId: r.responsibleUserId,
            userName,
            issueId: visible ? issue!.id : null,
            issueIdentifier: visible ? issue!.identifier : null,
            agentId: r.agentId,
            runId: null,
            connectionId: r.connectionId ?? "",
            provider: r.provider ?? "",
            model: r.model ?? "",
            status: r.status,
            connectionName,
            publicationStatus: publicationState ?? r.publicationStatus,
            errorCode: r.errorCode,
            startedAt: r.acceptedAt.toISOString(),
            finishedAt: r.finishedAt?.toISOString() ?? null,
            durationMs: r.durationMs,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            costCents:
              cost && cost.costStatus !== "unpriced"
                ? String(cost.costCents)
                : null,
            costStatus: cost?.costStatus ?? null,
          };
        },
      ),
    );
  }
  return {
    settings,
    choices,
    configure,
    availability,
    test,
    history,
    process,
    sweepPending,
    hasPending,
    authorize: (tx: Db, request: Request) => resolve(tx, request),
  };
}
