import { createHmac } from "node:crypto";
import {
  isCloudManagedInstance,
  type CloudInstanceEnv,
} from "./cloud-instance.js";

// Environment contract for the Plain support chat integration.
//
// `PLAIN_CHAT_APP_ID` — the Plain Chat App identifier (public, not a secret;
//   it is embedded in every page that mounts the widget). Absent → support
//   chat is off everywhere.
// `PLAIN_CHAT_EMAIL_HMAC_SECRET` — the Plain chat authentication secret.
//   Server-side only, bearer-grade: whoever holds it can mint a chat identity
//   for any email. Absent → the widget still mounts, but the session response
//   carries no attested customer identity and Plain's own email verification
//   flow covers identity instead.
// `PLAIN_API_KEY` — a Plain **Core API** key (scoped to `tenant:read` +
//   `tenant:create` + `tenant:edit`), used server-side to upsert the Plain tenant mirroring a
//   Paperclip company before the widget references it. Secret, server-side
//   env only. Absent → sessions carry no tenant context (chat still works;
//   support threads just lack the current-company association).
// `PAPERCLIP_SUPPORT_CHAT_DEV_PREVIEW` — explicit development-only opt-in for
//   testing the Cloud support surface on a local instance. Honored only when
//   the process does not run a production build (`NODE_ENV=production`) and
//   the instance is not Cloud-managed; both conditions fail closed.

export interface SupportChatRuntimeConfig {
  appId: string;
  emailHmacSecret: string | null;
  tenantSyncApiKey: string | null;
  /** True when enablement came from the dev opt-in, not a Cloud-managed signal. */
  devPreview: boolean;
}

function normalize(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function devPreviewRequested(env: CloudInstanceEnv): boolean {
  const value = normalize(env.PAPERCLIP_SUPPORT_CHAT_DEV_PREVIEW);
  return value === "1" || value === "true";
}

/**
 * Resolve whether this instance serves the Plain support chat surface, and
 * with which credentials. Returns `null` when support chat is disabled.
 *
 * Enablement is server-owned and fails closed:
 * - a Chat App id must be configured, and
 * - the instance must be Cloud-managed (`isCloudManagedInstance`), or
 * - the operator set the development-only opt-in on a non-production,
 *   non-Cloud process.
 *
 * `nodeEnv` is a parameter (defaulting to the process value) so tests can
 * prove the production refusal without mutating process state.
 */
export function resolveSupportChatConfig(
  env: CloudInstanceEnv = process.env,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): SupportChatRuntimeConfig | null {
  const appId = normalize(env.PLAIN_CHAT_APP_ID);
  if (!appId) return null;

  const cloudManaged = isCloudManagedInstance(env);
  const devPreview =
    !cloudManaged && nodeEnv !== "production" && devPreviewRequested(env);

  if (!cloudManaged && !devPreview) return null;

  return {
    appId,
    emailHmacSecret: normalize(env.PLAIN_CHAT_EMAIL_HMAC_SECRET),
    tenantSyncApiKey: normalize(env.PLAIN_API_KEY),
    devPreview,
  };
}

/**
 * Compute Plain's chat email authentication hash: hex-encoded HMAC-SHA256 of
 * the email address, keyed with the workspace's chat authentication secret
 * (https://www.plain.com/docs/chat/authentication). The result is a bearer
 * credential for the customer's chat identity — callers must never log it or
 * let it into any shared cache.
 */
export function computePlainEmailHash(secret: string, email: string): string {
  return createHmac("sha256", secret).update(email).digest("hex");
}
