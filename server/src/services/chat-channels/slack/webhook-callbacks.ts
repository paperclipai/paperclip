import { isProvisionedSlackSetup } from "@paperclipai/shared";
import { slackRequestSignatureIsValid, slackRequestWorkspaceId, slackCallbackMatchesPublicUrl, inspectSlackCallback } from "./callback-verification.js";
import type { InternalSetupState } from "../runtime-types.js";
import { notifyChatVerificationWork } from "../../chat-work-notifications.js";
import { chatSlackRegistrations } from "@paperclipai/db";
import { rememberVerifiedSlackSearchEvent } from "../../connectors/slack-search-context.js";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatEndpoints, toolConnections } from "@paperclipai/db";
import { logActivity } from "../../activity-log.js";
import type { EndpointRow, RuntimeContext } from "../runtime-types.js";
import type { createChatCredentials } from "../credentials.js";

import type { createChatMessageLifecycle } from "../inbound/lifecycle.js";
type SlackWebhookOptions = {
  resolveCredentials: ReturnType<typeof createChatCredentials>["resolveCredentials"];
  runtimeCallbackEndpoint: Parameters<typeof createChatMessageLifecycle>[1]["runtimeCallbackEndpoint"];
  getWebhookPublicBaseUrl: () => string | null;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  slackRegistration: { notifyVerified(endpointId: string): Promise<void> };
};
export function createSlackWebhookCallbacks(db: Db, options: SlackWebhookOptions) {
  const { resolveCredentials, runtimeCallbackEndpoint, getWebhookPublicBaseUrl, scheduleMessageProcessing, slackRegistration } = options;
  async function inspectSlackWebhookScope(endpoint: EndpointRow, request: Request): Promise<Response | null> {
    if (!endpoint.providerAccountId) return null;
    const inspection = request.clone();
    const body = await inspection.text();
    const credentials = await resolveCredentials(endpoint, db, ["signingSecret"]);
    if (
      slackRequestSignatureIsValid(
        inspection,
        body,
        credentials.signingSecret,
      )
    ) {
      const incomingWorkspaceId = slackRequestWorkspaceId(
        body,
        inspection.headers.get("content-type") ?? "",
      );
      if (
        incomingWorkspaceId &&
        incomingWorkspaceId !== endpoint.providerAccountId
      ) {
        // A Slack Request URL can be copied to another app/workspace. Even a
        // correctly signed callback belongs only to the bot identity verified
        // for this endpoint, so acknowledge foreign traffic without letting
        // it reach SDK callbacks, delivery admission, principals, or lifecycle.
        return new Response("ignored", { status: 200 });
      }
      if (incomingWorkspaceId === endpoint.providerAccountId) rememberVerifiedSlackSearchEvent(db, endpoint.id, endpoint.providerAccountId, body);
    }
    return null;
  }
  async function recordSlackWebhookCallback(endpoint: EndpointRow, request: Request, slackCallbackInspection: Request, runtimeContext: RuntimeContext): Promise<void> {
    const eventBody = await slackCallbackInspection.clone().text();
    const callback = await inspectSlackCallback(slackCallbackInspection);
    if (callback) {
      let connectionProved = false;
      await db.transaction(async (tx) => {
        const current = await runtimeCallbackEndpoint(
          tx,
          endpoint.id,
          runtimeContext,
          ["verifying", "active"],
        );
        if (!current) return;
        const observedAt = new Date();
        const currentSetup = current.setup as InternalSetupState;
        // A real message delivered to the configured URL proves ingress even
        // when Slack's separate Request URL verification flag remains unset.
        // Recheck the signature under the current credential/runtime fence;
        // an SDK acknowledgement alone is not authentication evidence.
        let signingFingerprint: string | null = null;
        if (!currentSetup.webhookVerifiedAt && isProvisionedSlackSetup(currentSetup.slackSetupMethod)
          && callback.surface === "events" && !callback.isUrlVerification
          && slackCallbackMatchesPublicUrl(callback.url, `${getWebhookPublicBaseUrl()}/api/chat-webhooks/${current.publicId}/slack`)) {
          const payload = JSON.parse(eventBody) as { type?: string; team_id?: string; api_app_id?: string; event_id?: string; event?: { type?: string } };
          const [registration] = await tx.select().from(chatSlackRegistrations)
            .where(and(eq(chatSlackRegistrations.endpointId, current.id), eq(chatSlackRegistrations.companyId, current.companyId)));
          const [connection] = await tx.select({ status: toolConnections.status, enabled: toolConnections.enabled }).from(toolConnections)
            .where(and(eq(toolConnections.id, current.connectionId), eq(toolConnections.companyId, current.companyId)));
          if (connection?.status === "active" && connection.enabled && registration?.status === "configured"
            && registration.workspaceId === current.providerAccountId && registration.botUserId === current.botExternalId
            && payload.type === "event_callback" && typeof payload.event_id === "string" && payload.event_id.length > 0
            && payload.api_app_id === registration.appId && payload.team_id === current.providerAccountId
            && ["message", "app_mention"].includes(payload.event?.type ?? "")) {
            const credentials = await resolveCredentials(current, tx, ["signingSecret"]);
            if (slackRequestSignatureIsValid(request, eventBody, credentials.signingSecret))
              signingFingerprint = createHash("sha256").update(credentials.signingSecret).digest("hex");
          }
        }
        connectionProved = signingFingerprint !== null;
        if (connectionProved) await notifyChatVerificationWork(tx);
        await tx
          .update(chatEndpoints)
          .set({
            setup: {
              ...currentSetup,
              ...(connectionProved
                ? {
                  webhookVerifiedAt: observedAt.toISOString(), slackVerificationSigningFingerprint: signingFingerprint!,
                  ...(currentSetup.slackAccount?.status === "linked" && !currentSetup.slackAccount.verificationStatus
                    ? { slackAccount: { ...currentSetup.slackAccount, verificationStatus: "pending" as const } } : {})
                }
                : {}),
              slackCallbackSurfaces: {
                ...currentSetup.slackCallbackSurfaces,
                [callback.surface]: {
                  url: callback.url,
                  observedAt: observedAt.toISOString(),
                },
              },
            } as InternalSetupState,
            ...(connectionProved
              ? { healthMessage: "Slack connection confirmed by an authenticated event" }
              : {}),
            updatedAt: observedAt,
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        if (connectionProved) await logActivity(tx as unknown as Db, {
          companyId: current.companyId, actorType: "system", actorId: "slack-webhook",
          action: "chat_endpoint.webhook_verified", entityType: "tool_connection", entityId: current.connectionId,
          details: { endpointId: current.id, provider: "slack", evidence: "authenticated_event" },
        });
      });
      if (connectionProved) scheduleMessageProcessing(() => slackRegistration.notifyVerified(endpoint.id));
    }
  }
  return { inspectSlackWebhookScope, recordSlackWebhookCallback };
}
