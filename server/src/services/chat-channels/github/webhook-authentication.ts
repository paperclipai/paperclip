import { type GitHubIngressStageResult } from "./webhook-ingress.js";

import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { recordChatWebhookReceipt } from "../../chat-webhook-diagnostics.js";
import type { Db } from "@paperclipai/db";
import { chatEndpoints } from "@paperclipai/db";
import { logger } from "../../../middleware/logger.js";
import { logActivity } from "../../activity-log.js";
import type { EndpointRow } from "../runtime-types.js";
import type { GitHubWebhookScope } from "./webhook-scope.js";
import type { createGitHubWebhookIngress } from "./webhook-ingress.js";
import type { createChatCredentials } from "../credentials.js";
import type { createChatResourceReconciliation } from "../resource-reconciliation.js";
type AuthenticationOptions = Pick<Parameters<typeof createGitHubWebhookIngress>[1], "endpointRecord" | "runtimeContextForRecord" | "withCredentialMutationLease" | "redactError"> & Pick<ReturnType<typeof createGitHubWebhookIngress>, "stageGitHubWebhookIngress" | "processGitHubWebhookIngress" | "githubIngressAcceptedResponse"> & {
  resolveCredentials: ReturnType<typeof createChatCredentials>["resolveCredentials"];
  reconcileGitHubWebhookRepository: ReturnType<typeof createChatResourceReconciliation>["reconcileGitHubWebhookRepository"];
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  backgroundMessageTasks: Set<Promise<void>>;
  readonly githubWebhookAuthenticationBarrier?: () => Promise<void>;
  readonly deferWebhookProcessing?: boolean;
};
export function retryableGitHubWebhookResponse(): Response {
  return new Response(
    "Paperclip could not durably accept the event in time",
    {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": "1",
      },
    },
  );
}
export function createGitHubWebhookAuthentication(db: Db, options: AuthenticationOptions) {
  const { endpointRecord, runtimeContextForRecord, withCredentialMutationLease, resolveCredentials, reconcileGitHubWebhookRepository, stageGitHubWebhookIngress, processGitHubWebhookIngress, githubIngressAcceptedResponse, scheduleMessageProcessing, backgroundMessageTasks, redactError } = options;
  async function authenticateGitHubWebhook(endpoint: EndpointRow, request: Request, scope: GitHubWebhookScope): Promise<Response | null> {
    const { replayingDurableGitHubIngress, matchesGitHubIngressFence, completeGitHubPreflightBeforeDeadline } = scope;
    if (!replayingDurableGitHubIngress) {
      await options.githubWebhookAuthenticationBarrier?.();
      let staged: GitHubIngressStageResult;
      try {
        staged = await stageGitHubWebhookIngress(endpoint, request.clone());
      } catch (error) {
        logger.warn(
          { endpointId: endpoint.id, error: redactError(error) },
          "GitHub webhook could not be durably authenticated",
        );
        return retryableGitHubWebhookResponse();
      }
      if (staged.kind === "invalid_signature")
        return new Response("Invalid signature", { status: 401 });
      if (staged.kind === "ignored")
        return new Response("ignored", { status: 200 });
      recordChatWebhookReceipt(endpoint.id, staged.actionId, "github_ingress");

      if (options.deferWebhookProcessing === true) {
        scheduleMessageProcessing(async () => {
          await processGitHubWebhookIngress(staged.actionId);
        });
        return githubIngressAcceptedResponse();
      }

      const processing = processGitHubWebhookIngress(staged.actionId, true);
      const tracked = processing.then(
        () => undefined,
        () => undefined,
      );
      backgroundMessageTasks.add(tracked);
      void tracked.finally(() => backgroundMessageTasks.delete(tracked));
      const outcome = await completeGitHubPreflightBeforeDeadline(processing);
      return outcome.completed
        ? (outcome.value ?? githubIngressAcceptedResponse())
        : githubIngressAcceptedResponse();
    }
    const inspection = request.clone();
    const body = await inspection.text();
    const signature = inspection.headers.get("x-hub-signature-256");
    const eventType = inspection.headers.get("x-github-event");
    if (!replayingDurableGitHubIngress)
      await options.githubWebhookAuthenticationBarrier?.();
    if (eventType === "ping") {
      let verifiedAttempt:
        | { completed: true; value: boolean }
        | { completed: false; value?: never };
      const verification = withCredentialMutationLease(
        endpoint,
        async (credentialLease): Promise<boolean> => {
          const current = await endpointRecord(endpoint.id);
          if (
            !current ||
            current.endpoint.provider !== "github" ||
            !matchesGitHubIngressFence(runtimeContextForRecord(current)) ||
            ["archived", "paused", "revoked"].includes(
              current.endpoint.status,
            )
          )
            return false;
          const credentials = await resolveCredentials(current.endpoint);
          const expected = `sha256=${createHmac("sha256", credentials.webhookSecret).update(body).digest("hex")}`;
          let valid = false;
          try {
            valid =
              typeof signature === "string" &&
              timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
          } catch {
            valid = false;
          }
          if (!valid) return false;
          const verifiedAt = new Date();
          await db.transaction(async (tx) => {
            // Bind the verified receipt to the same lease and secret that
            // authenticated it. A reclaimed lease cannot commit a stale
            // webhook verification after secret rotation or reconnect.
            await credentialLease.assertOwned(tx);
            await tx
              .update(chatEndpoints)
              .set({
                setup: {
                  ...current.endpoint.setup,
                  webhookVerifiedAt: verifiedAt.toISOString(),
                },
                healthMessage: "GitHub webhook verified",
                updatedAt: verifiedAt,
              })
              .where(eq(chatEndpoints.id, endpoint.id));
            await logActivity(tx as unknown as Db, {
              companyId: current.endpoint.companyId,
              actorType: "system",
              actorId: "github-webhook",
              action: "chat_endpoint.webhook_verified",
              entityType: "tool_connection",
              entityId: current.endpoint.connectionId,
              details: {
                endpointId: current.endpoint.id,
                provider: "github",
                providerDeliveryId:
                  inspection.headers.get("x-github-delivery") ?? null,
              },
            });
            await credentialLease.assertOwned(tx);
          });
          return true;
        },
      );
      try {
        verifiedAttempt =
          await completeGitHubPreflightBeforeDeadline(verification);
      } catch (error) {
        logger.warn(
          { endpointId: endpoint.id, error: redactError(error) },
          "GitHub ping authentication failed before durable verification",
        );
        return retryableGitHubWebhookResponse();
      }
      if (!verifiedAttempt.completed) {
        // This path is reachable only for the private durable worker. The
        // public request has already committed its authenticated receipt.
        void verification.catch((error) => {
          logger.warn(
            { endpointId: endpoint.id, error: redactError(error) },
            "timed-out GitHub ping authentication later failed",
          );
        });
        return retryableGitHubWebhookResponse();
      }
      const verified = verifiedAttempt.value;
      return verified
        ? new Response("pong", { status: 200 })
        : new Response("Invalid signature", { status: 401 });
    }
    const preflightTask = withCredentialMutationLease(
      endpoint,
      async (
        credentialLease,
      ): Promise<"accepted" | "ignored" | "invalid_signature"> => {
        // The repository upsert below is a Paperclip mutation derived from
        // the webhook credential. Re-read and authenticate while holding the
        // same lease as rotation/reconnect/removal so a callback signed with
        // an obsolete secret cannot reopen a quarantined repository in the
        // resolve-secret -> persist-resource race window.
        const current = await endpointRecord(endpoint.id);
        if (
          !current ||
          current.endpoint.provider !== "github" ||
          !matchesGitHubIngressFence(runtimeContextForRecord(current)) ||
          current.endpoint.status === "archived" ||
          current.endpoint.status === "paused" ||
          (current.endpoint.status === "revoked" &&
            eventType !== "installation")
        ) {
          return "ignored";
        }
        const credentials = await resolveCredentials(current.endpoint);
        const expected = `sha256=${createHmac("sha256", credentials.webhookSecret).update(body).digest("hex")}`;
        let signatureValid = false;
        try {
          signatureValid =
            typeof signature === "string" &&
            timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
        } catch {
          signatureValid = false;
        }
        if (!signatureValid) return "invalid_signature";

        let payload: {
          installation?: { id?: unknown };
          repository?: unknown;
        } | null = null;
        try {
          payload = JSON.parse(body) as {
            installation?: { id?: unknown };
            repository?: unknown;
          };
        } catch {
          // Let the native adapter return its normal invalid-JSON response.
        }
        if (payload) {
          const incomingInstallationId = payload.installation?.id;
          if (
            incomingInstallationId !== undefined &&
            String(incomingInstallationId) !== credentials.installationId &&
            eventType !== "installation"
          ) {
            // A dedicated endpoint represents exactly one GitHub App
            // installation. GitHub sends every installation's events to the
            // App webhook, so acknowledge foreign signed traffic without
            // admitting it to Paperclip or prompting endless redelivery.
            // Installation lifecycle events are the one exception: even when
            // their id differs, canonical App inventory under the lifecycle
            // lease must decide whether this is a valid sole-installation
            // replacement or a second active installation that quarantines
            // the endpoint.
            return "ignored";
          }
          await reconcileGitHubWebhookRepository(
            current.endpoint,
            payload,
            credentialLease,
          );
        }
        return "accepted";
      },
    );
    let preflightAttempt:
      | {
        completed: true;
        value: "accepted" | "ignored" | "invalid_signature";
      }
      | { completed: false; value?: never };
    try {
      preflightAttempt =
        await completeGitHubPreflightBeforeDeadline(preflightTask);
    } catch (error) {
      logger.warn(
        { endpointId: endpoint.id, error: redactError(error) },
        "GitHub webhook authentication failed before durable acceptance",
      );
      return retryableGitHubWebhookResponse();
    }
    if (!preflightAttempt.completed) {
      void preflightTask.catch((error) => {
        logger.warn(
          { endpointId: endpoint.id, error: redactError(error) },
          "timed-out GitHub webhook authentication later failed",
        );
      });
      return retryableGitHubWebhookResponse();
    }
    const preflight = preflightAttempt.value;
    if (preflight === "ignored") {
      return new Response("ignored", { status: 200 });
    }
    if (preflight === "invalid_signature") {
      return new Response("Invalid signature", { status: 401 });
    }
    return null;
  }
  return { authenticateGitHubWebhook };
}
