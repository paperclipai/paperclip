import { isProvisionedSlackSetup } from "@paperclipai/shared";
import type { EndpointRow, DbOrTransaction, SlackCallbackSurface, InternalSetupState } from "../runtime-types.js";

import { notifyChatVerificationWork } from "../../chat-work-notifications.js";

import { slackChatRegistrationService } from "../../chat-slack-registration.js";
import { chatSlackRegistrations } from "@paperclipai/db";

import { runtimeCanonicalOrigin } from "../../cloud-runtime-identity.js";

import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  and,
  eq,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatEndpoints,
  toolConnections,
} from "@paperclipai/db";
import type {
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import {
  logActivity,
} from "../../activity-log.js";

import { secretService } from "../../secrets.js";

/** A signed provider challenge remains valid when those exact credentials enter the runtime vault. */
export function preservesProvisionedSlackVerification(setup: EndpointRow["setup"], signingSecret: string, webhookUrl: string): boolean {
  const internal = setup as InternalSetupState;
  const observedUrl = internal.slackCallbackSurfaces?.events?.url;
  return !!setup.webhookVerifiedAt && isProvisionedSlackSetup(setup.slackSetupMethod)
    && internal.slackVerificationSigningFingerprint === createHash("sha256").update(signingSecret).digest("hex")
    && !!observedUrl && slackCallbackMatchesPublicUrl(observedUrl, webhookUrl);
}

function slackRequestSignatureIsValid(
  request: Request,
  body: string,
  signingSecret: string,
): boolean {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 300
  )
    return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function slackRequestWorkspaceId(
  body: string,
  contentType: string,
): string | null {
  let payload: unknown;
  try {
    if (contentType.includes("application/json")) {
      payload = JSON.parse(body);
    } else {
      const form = new URLSearchParams(body);
      const interactivePayload = form.get("payload");
      payload = interactivePayload
        ? JSON.parse(interactivePayload)
        : Object.fromEntries(form.entries());
    }
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const nestedId = (value: unknown): string | null => {
    if (!value || typeof value !== "object") return null;
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  };
  const stringField = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const authorization = Array.isArray(record.authorizations)
    ? record.authorizations.find(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === "object",
      )
    : null;
  const authorizationField = (key: string): string | null => {
    const value = authorization?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  // A Grid event may carry both an enterprise id and the concrete workspace
  // id. The bot identity is verified against auth.test's team_id, so prefer a
  // team id and use the enterprise id only when Slack omitted team context.
  return (
    stringField("team_id") ??
    nestedId(record.team) ??
    authorizationField("team_id") ??
    stringField("enterprise_id") ??
    nestedId(record.enterprise) ??
    authorizationField("enterprise_id")
  );
}

function canonicalCallbackUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hostname = url.hostname.replace(/\.$/, "");
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

// TLS terminates at a reverse proxy in many self-hosted deployments. The
// transport scheme is not evidence of URL drift; authority and path still are.
// This is diagnostic only: it does not trust forwarded headers or change auth.
function slackCallbackMatchesPublicUrl(observed: string, current: string): boolean {
  const canonical = canonicalCallbackUrl(observed);
  if (canonical === current) return true;
  if (!canonical) return false;
  const observedUrl = new URL(canonical);
  const currentUrl = new URL(current);
  return observedUrl.protocol === "http:"
    && currentUrl.protocol === "https:"
    && observedUrl.host === currentUrl.host
    && observedUrl.pathname === currentUrl.pathname;
}

async function inspectSlackCallback(
  request: Request,
): Promise<SlackCallbackInspection | null> {
  const url = slackCallbackObservationUrl(request);
  if (!url) return null;
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  let body: string;
  try {
    body = await request.text();
  } catch {
    return null;
  }
  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(body) as {
        type?: unknown;
        challenge?: unknown;
      };
      const isUrlVerification =
        payload.type === "url_verification" &&
        typeof payload.challenge === "string" &&
        payload.challenge.length > 0;
      if (isUrlVerification || payload.type === "event_callback") {
        return {
          surface: "events",
          url,
          isUrlVerification,
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  const form = new URLSearchParams(body);
  if (form.get("command")) {
    return { surface: "slashCommands", url, isUrlVerification: false };
  }
  const interactivePayload = form.get("payload");
  if (!interactivePayload) return null;
  try {
    const payload = JSON.parse(interactivePayload) as { type?: unknown };
    if (
      typeof payload.type === "string" &&
      [
        "block_actions",
        "block_suggestion",
        "dialog_submission",
        "message_action",
        "shortcut",
        "view_closed",
        "view_submission",
        "workflow_step_edit",
      ].includes(payload.type)
    ) {
      return { surface: "interactivity", url, isUrlVerification: false };
    }
  } catch {
    return null;
  }
  return null;
}

type SlackCallbackInspection = {
  surface: SlackCallbackSurface;
  url: string;
  isUrlVerification: boolean;
};

// Cloud records the public request host in dedicated headers so provider edges
// cannot replace it with their upstream host. Only use callback-health evidence on a
// claimed Cloud instance, after provider authentication succeeded. It must not
// change the Request passed to the adapter, signature verification, routing,
// board identity, or the configured URL used to generate callbacks.
function slackCallbackObservationUrl(request: Request): string | null {
  const directUrl = canonicalCallbackUrl(request.url);
  if (!directUrl || !runtimeCanonicalOrigin()) return directUrl;
  const hasCloudEvidence = request.headers.has("x-paperclip-cloud-forwarded-host");
  const host = request.headers.get(hasCloudEvidence ? "x-paperclip-cloud-forwarded-host" : "x-forwarded-host")?.trim();
  const protocol = request.headers.get(hasCloudEvidence ? "x-paperclip-cloud-forwarded-proto" : "x-forwarded-proto")?.trim();
  if (!host || /[\s/@\\?#,]/.test(host) || (protocol !== "https" && protocol !== "http")) return directUrl;
  try {
    const origin = new URL(`${protocol}://${host}`);
    // Accept one authority only, never credentials, paths, queries, or lists.
    if (!origin.host || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return directUrl;
    const observed = new URL(directUrl);
    observed.protocol = origin.protocol;
    observed.host = origin.host;
    observed.port = origin.port;
    return canonicalCallbackUrl(observed.toString());
  } catch {
    return directUrl;
  }
}
export { slackRequestSignatureIsValid, slackRequestWorkspaceId, canonicalCallbackUrl, slackCallbackMatchesPublicUrl, inspectSlackCallback };

type SlackCallbackVerificationOptions = {
  resolveCredentialRefs: (endpoint: EndpointRow, refs: ToolCredentialSecretRef[], database?: DbOrTransaction) => Promise<Record<string, string>>;
  getWebhookPublicBaseUrl: () => string | null;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  slackRegistration: Pick<ReturnType<typeof slackChatRegistrationService>, "notifyVerified">;
};

export function createSlackCallbackVerification(db: Db, options: SlackCallbackVerificationOptions) {
  const { resolveCredentialRefs, getWebhookPublicBaseUrl, scheduleMessageProcessing, slackRegistration } = options;


  async function verifySlackRequestUrl(endpoint: EndpointRow, request: Request): Promise<Response | null> {
    const callback = await inspectSlackCallback(request.clone());
    if (!callback?.isUrlVerification) return null;
    const body = await request.clone().text();
    let notifyAccount = false;
    // URL verification needs only the signing secret. Do not initialize the
    // SDK (which calls Slack auth.test), wait for OAuth, or acquire the creation
    // lease: Slack can deliver this check while app setup still owns that lease.
    const response = await db.transaction(async tx => {
      const [current] = await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)).for("no key update");
      if (!current || ["archived", "paused", "revoked"].includes(current.status)) return new Response("ignored", { status: 200 });
      const [connection] = await tx.select({ status: toolConnections.status, refs: toolConnections.credentialSecretRefs }).from(toolConnections)
        .where(and(eq(toolConnections.id, current.connectionId), eq(toolConnections.companyId, current.companyId)));
      if (!connection || connection.status === "archived") return new Response("ignored", { status: 200 });
      let secret = (await resolveCredentialRefs(current, connection.refs.filter(ref => ref.configPath.replace(/^credentials\./, "") === "signingSecret"), tx)).signingSecret;
      if (!secret && isProvisionedSlackSetup(current.setup.slackSetupMethod)) {
        const [registration] = await tx.select().from(chatSlackRegistrations)
          .where(and(eq(chatSlackRegistrations.endpointId, current.id), eq(chatSlackRegistrations.companyId, current.companyId)));
        if (registration?.status !== "removed" && registration?.secretIds.signingSecret) {
          secret = await secretService(tx as unknown as Db).resolveSecretValue(current.companyId, registration.secretIds.signingSecret, "latest", {
            accessContext: { consumerType: "system", consumerId: `slack-registration:${current.id}`, configPath: "slack_registration.signingSecret", actorType: "system" },
          });
        }
      }
      if (!secret) return new Response("Slack signing secret is not ready yet", { status: 503 });
      if (!slackRequestSignatureIsValid(request, body, secret)) return new Response("Invalid signature", { status: 401 });
      const workspaceId = slackRequestWorkspaceId(body, request.headers.get("content-type") ?? "");
      if (workspaceId && current.providerAccountId && workspaceId !== current.providerAccountId) return new Response("ignored", { status: 200 });
      const observedAt = new Date();
      const setup = current.setup as InternalSetupState;
      const matchesCurrentUrl = slackCallbackMatchesPublicUrl(callback.url, `${getWebhookPublicBaseUrl()}/api/chat-webhooks/${current.publicId}/slack`);
      await notifyChatVerificationWork(tx);
      await tx.update(chatEndpoints).set({ setup: {
        ...setup,
        ...(matchesCurrentUrl ? { webhookVerifiedAt: setup.webhookVerifiedAt ?? observedAt.toISOString(),
          slackVerificationSigningFingerprint: createHash("sha256").update(secret).digest("hex") } : {}),
        slackCallbackSurfaces: { ...setup.slackCallbackSurfaces, events: { url: callback.url, observedAt: observedAt.toISOString() } },
        ...(matchesCurrentUrl && setup.slackAccount?.status === "linked" && !setup.slackAccount.verificationStatus
          ? { slackAccount: { ...setup.slackAccount, verificationStatus: "pending" as const } } : {}),
      } as InternalSetupState, ...(matchesCurrentUrl ? { healthMessage: "Slack Events Request URL verified" } : {}), updatedAt: observedAt }).where(eq(chatEndpoints.id, current.id));
      if (matchesCurrentUrl && !setup.webhookVerifiedAt) await logActivity(tx as unknown as Db, { companyId: current.companyId, actorType: "system", actorId: "slack-webhook",
        action: "chat_endpoint.webhook_verified", entityType: "tool_connection", entityId: current.connectionId,
        details: { endpointId: current.id, provider: "slack" } });
      notifyAccount = matchesCurrentUrl && setup.slackAccount?.status === "linked" && !setup.slackAccount.verificationStatus;
      return Response.json({ challenge: (JSON.parse(body) as { challenge: string }).challenge });
    });
    if (notifyAccount) scheduleMessageProcessing(() => slackRegistration.notifyVerified(endpoint.id));
    return response;
  }
  return { verifySlackRequestUrl };
}
