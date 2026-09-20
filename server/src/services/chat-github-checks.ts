import { and, desc, eq, or, sql } from "drizzle-orm";
import {
  chatActions,
  chatDeliveries,
  chatEndpoints,
  chatEndpointResources,
  chatGitHubConfigurations,
  chatGitHubReviews,
  chatMessageLinks,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import type { GitHubReviewEventContext } from "@paperclipai/shared";
import {
  githubBotRepositoryToken,
  githubBotRequest,
} from "./chat-github-client.js";

/** Check status follows the ordinary chat delivery/task/run. This outbox never
 * schedules an agent. Assessments are published by the governed review tool. */
export function githubReviewCheckService(db: Db, fetchImpl = fetch) {
  async function enqueue(
    endpoint: typeof chatEndpoints.$inferSelect,
    event: GitHubReviewEventContext,
    admitted: boolean,
    reason: string,
  ) {
    const [config] = await db
      .select()
      .from(chatGitHubConfigurations)
      .where(eq(chatGitHubConfigurations.endpointId, endpoint.id));
    if (!config?.configuration.toolsEnabled) return;
    const policy = {
      ...config.configuration.defaults,
      ...config.configuration.repositories[event.repositoryId],
    };
    if (policy.ratingThreshold === null && !admitted) return;
    await db
      .insert(chatActions)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        kind: "github_review_check",
        providerActionId: `github-check:${event.deliveryId}`,
        payload: {
          version: 1,
          event,
          admitted,
          reason,
          runtimeGeneration:
            (endpoint.setup as { runtimeGeneration?: number })
              .runtimeGeneration ?? 0,
        },
        status: "received",
      })
      .onConflictDoNothing();
  }
  async function dispatch(id: string) {
    await db.transaction(async (tx) => {
      const [action] = await tx
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.id, id),
            eq(chatActions.kind, "github_review_check"),
          ),
        )
        .for("update", { skipLocked: true });
      if (!action || ["processed", "cancelled"].includes(action.status)) return;
      const event = action.payload.event as GitHubReviewEventContext;
      let attempts = Number(action.result?.attempts ?? 0);
      try {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`github-publish:${action.endpointId}:${event.repositoryId}:${event.pullNumber}`}, 0))`,
        );
        const [source] = await tx
          .select({
            endpoint: chatEndpoints,
            resource: chatEndpointResources,
            configuration: chatGitHubConfigurations.configuration,
          })
          .from(chatEndpoints)
          .innerJoin(
            chatGitHubConfigurations,
            eq(chatGitHubConfigurations.endpointId, chatEndpoints.id),
          )
          .innerJoin(
            chatEndpointResources,
            eq(chatEndpointResources.endpointId, chatEndpoints.id),
          )
          .where(
            and(
              eq(chatEndpoints.id, action.endpointId),
              eq(chatEndpoints.companyId, action.companyId),
              eq(chatEndpointResources.providerResourceId, event.repository),
            ),
          );
        if (
          !source ||
          !source.configuration.toolsEnabled ||
          !["active", "verifying"].includes(source.endpoint.status) ||
          !source.resource.enabled ||
          source.resource.availability !== "available" ||
          String(source.resource.metadata?.providerRepositoryId) !==
            event.repositoryId ||
          ((source.endpoint.setup as { runtimeGeneration?: number })
            .runtimeGeneration ?? 0) !== action.payload.runtimeGeneration
        ) {
          await tx
            .update(chatActions)
            .set({
              status: "cancelled",
              result: { code: "connection_changed" },
              updatedAt: new Date(),
            })
            .where(eq(chatActions.id, id));
          return;
        }
        const [review] = await tx
          .select()
          .from(chatGitHubReviews)
          .where(
            and(
              eq(chatGitHubReviews.endpointId, action.endpointId),
              eq(chatGitHubReviews.repositoryId, event.repositoryId),
              eq(chatGitHubReviews.pullNumber, event.pullNumber),
              eq(chatGitHubReviews.headSha, event.headSha),
            ),
          )
          .orderBy(desc(chatGitHubReviews.createdAt))
          .limit(1);
        if (review?.assessment) {
          // The assessment outbox owns the terminal score and its retries.
          await tx
            .update(chatActions)
            .set({
              status: "processed",
              result: { code: "assessment_owns_check", reviewId: review.id },
              updatedAt: new Date(),
            })
            .where(eq(chatActions.id, id));
          return;
        }
        let run = review?.runId
          ? (
              await tx
                .select()
                .from(heartbeatRuns)
                .where(eq(heartbeatRuns.id, review.runId))
            )[0]
          : undefined;
        if (review && !run) {
          const [sourceRun] = await tx
            .select({ run: heartbeatRuns })
            .from(chatDeliveries)
            .innerJoin(
              chatMessageLinks,
              eq(chatMessageLinks.deliveryId, chatDeliveries.id),
            )
            .innerJoin(
              heartbeatRuns,
              and(
                eq(heartbeatRuns.companyId, action.companyId),
                eq(heartbeatRuns.agentId, source.endpoint.assignedAgentId),
                sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${chatMessageLinks.commentId}::text`,
              ),
            )
            .where(
              and(
                eq(chatDeliveries.endpointId, action.endpointId),
                sql`${chatDeliveries.normalizedEvent}->'githubAutomatic'->'context'->>'deliveryId' = ${event.deliveryId}`,
              ),
            )
            .orderBy(desc(heartbeatRuns.createdAt))
            .limit(1);
          run = sourceRun?.run;
        }
        const [delivery] = await tx
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, action.endpointId),
              sql`${chatDeliveries.normalizedEvent}->'githubAutomatic'->'context'->>'deliveryId' = ${event.deliveryId}`,
            ),
          )
          .limit(1);
        const admissionEnded =
          !review &&
          (delivery?.state === "filtered" || delivery?.state === "failed");
        const terminal =
          !!run &&
          ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(
            run.status,
          );
        const state =
          (!action.payload.admitted && !review) || admissionEnded
            ? "manual_required"
            : terminal
              ? run!.status === "succeeded"
                ? "incomplete"
                : "error"
              : run?.status === "running"
                ? "running"
                : "queued";
        const status =
          state === "running"
            ? "in_progress"
            : state === "queued"
              ? "queued"
              : "completed";
        const title =
          state === "manual_required"
            ? "Authorized manual review required"
            : state === "incomplete"
              ? "Agent finished without a complete assessment"
              : state === "error"
                ? "Review execution did not complete"
                : state === "running"
                  ? "Agent is reviewing this commit"
                  : "Waiting for the assigned agent";
        const token = await githubBotRepositoryToken(
          db,
          action.companyId,
          action.endpointId,
          event.repositoryId,
          fetchImpl,
        );
        const prefix = `/repos/${event.repository.split("/").map(encodeURIComponent).join("/")}`;
        const request = <T>(
          path: string,
          options?: Parameters<typeof githubBotRequest>[3],
        ) => githubBotRequest<T>(fetchImpl, token, `${prefix}${path}`, options);
        const current = await request<{ head: { sha: string } }>(
          `/pulls/${event.pullNumber}`,
        );
        if (current.head.sha !== event.headSha) {
          if (review)
            await tx
              .update(chatGitHubReviews)
              .set({ state: "superseded", updatedAt: new Date() })
              .where(eq(chatGitHubReviews.id, review.id));
          await tx
            .update(chatActions)
            .set({
              status: "cancelled",
              result: { code: "stale_head" },
              updatedAt: new Date(),
            })
            .where(eq(chatActions.id, id));
          return;
        }
        if (action.result?.state !== state) {
          const externalId = `${action.endpointId}:${event.pullNumber}:${event.headSha}`;
          const checks = await request<{
            check_runs: Array<{
              id: number;
              status?: string;
              external_id?: string;
              app?: { id?: number };
            }>;
          }>(
            `/commits/${event.headSha}/check-runs?check_name=Paperclip%20Review&per_page=100`,
          );
          const check = checks.check_runs.find(
            (check) =>
              check.external_id === externalId &&
              String(check.app?.id) === source.endpoint.botExternalId,
          );
          // GitHub retains a completed check's conclusion when PATCHed back to
          // queued/in_progress. A fresh attempt needs a new check run with the
          // same stable name; otherwise a prior success still looks passing.
          const updateCheck = check && !(check.status === "completed" && status !== "completed");
          const posted = await request<{ id: number; html_url: string }>(
            updateCheck ? `/check-runs/${check.id}` : "/check-runs",
            {
              method: updateCheck ? "PATCH" : "POST",
              body: {
                name: "Paperclip Review",
                head_sha: event.headSha,
                external_id: externalId,
                status,
                ...(status === "completed"
                  ? { conclusion: "action_required" }
                  : {}),
                output: {
                  title,
                  summary: `${title}. ${state === "manual_required" ? "An authorized person can mention the bot to request a review of this head. Automatic review was not authorized by the bot configuration." : "This check follows the assigned Paperclip agent's task execution. Only a validated assessment can produce a passing score."}\n\nCommit: ${event.headSha}`,
                },
              },
            },
          );
          if (review)
            await tx
              .update(chatGitHubReviews)
              .set({
                state,
                runId: run?.id ?? review.runId,
                checkId: String(posted.id),
                checkUrl: posted.html_url,
                ...(terminal ? { conclusion: "action_required" as const } : {}),
                updatedAt: new Date(),
              })
              .where(eq(chatGitHubReviews.id, review.id));
        }
        await tx
          .update(chatActions)
          .set({
            status: status === "completed" ? "processed" : "received",
            result: {
              state,
              attempts: 0,
              retryable: true,
              retryAt: new Date(Date.now() + 5000).toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, id));
      } catch {
        attempts++;
        await tx
          .update(chatActions)
          .set({
            status: "failed",
            result: {
              attempts,
              retryable: attempts < 8,
              retryAt: new Date(
                Date.now() + Math.min(300000, 1000 * 2 ** attempts),
              ).toISOString(),
              code: "check_publication_failed",
            },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, id));
      }
    });
  }
  async function processPending(limit = 10) {
    const rows = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "github_review_check"),
          or(
            and(
              eq(chatActions.status, "received"),
              sql`(${chatActions.result}->>'retryAt' is null or (${chatActions.result}->>'retryAt')::timestamptz <= now())`,
            ),
            and(
              eq(chatActions.status, "failed"),
              sql`${chatActions.result}->>'retryable' = 'true'`,
              sql`(${chatActions.result}->>'retryAt')::timestamptz <= now()`,
            ),
          ),
        ),
      )
      .orderBy(chatActions.updatedAt)
      .limit(limit);
    for (const row of rows) await dispatch(row.id);
  }
  return { enqueue, processPending };
}
