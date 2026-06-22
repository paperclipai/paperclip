import webpush from "web-push";
import { logger } from "../middleware/logger.js";
import type { StoredPushSubscription } from "./push-subscription-store.js";

/**
 * Web Push (VAPID) transport wrapper (TON-2312).
 *
 * VAPID keys are read from the environment so they live alongside the rest of
 * the server's secrets (loaded via dotenv in config.ts before this module is
 * used). When keys are absent the service is a safe no-op: subscription routes
 * still work but no pushes are sent. Generate a keypair once with:
 *
 *   node server/scripts/generate-vapid-keys.mjs
 *
 * then set PAPERCLIP_VAPID_PUBLIC_KEY / PAPERCLIP_VAPID_PRIVATE_KEY (and
 * optionally PAPERCLIP_VAPID_SUBJECT, a mailto: or https: contact URL).
 */

export interface PushNotificationPayload {
  title: string;
  body: string;
  /** Relative URL to open when the notification is clicked. */
  url?: string;
  /** Coalescing tag so repeat notifications for one entity replace each other. */
  tag?: string;
}

interface VapidState {
  configured: boolean;
  publicKey: string | null;
}

let cached: VapidState | null = null;

function initVapid(): VapidState {
  if (cached) return cached;

  const publicKey = process.env.PAPERCLIP_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.PAPERCLIP_VAPID_PRIVATE_KEY?.trim();
  const subject =
    process.env.PAPERCLIP_VAPID_SUBJECT?.trim() || "mailto:notifications@paperclip.local";

  if (!publicKey || !privateKey) {
    cached = { configured: false, publicKey: null };
    return cached;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    cached = { configured: true, publicKey };
  } catch (err) {
    logger.warn({ err }, "Failed to configure Web Push VAPID details; push disabled");
    cached = { configured: false, publicKey: null };
  }
  return cached;
}

/** True when VAPID keys are present and valid. */
export function isPushConfigured(): boolean {
  return initVapid().configured;
}

/** Public VAPID key the browser needs to subscribe, or null when unconfigured. */
export function getVapidPublicKey(): string | null {
  return initVapid().publicKey;
}

/**
 * Send a payload to every subscription. Returns the endpoints that are gone
 * (HTTP 404/410) so the caller can prune them. Never throws.
 */
export async function sendPushToSubscriptions(
  subscriptions: readonly StoredPushSubscription[],
  payload: PushNotificationPayload,
): Promise<{ expiredEndpoints: string[] }> {
  if (!isPushConfigured() || subscriptions.length === 0) {
    return { expiredEndpoints: [] };
  }

  const body = JSON.stringify(payload);
  const expiredEndpoints: string[] = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
        );
      } catch (err) {
        const statusCode =
          err && typeof err === "object" && "statusCode" in err
            ? Number((err as { statusCode: unknown }).statusCode)
            : undefined;
        if (statusCode === 404 || statusCode === 410) {
          expiredEndpoints.push(sub.endpoint);
        } else {
          logger.warn({ err, statusCode, endpoint: sub.endpoint }, "Web Push delivery failed");
        }
      }
    }),
  );

  return { expiredEndpoints };
}

/** Reset cached VAPID state. Test-only. */
export function __resetPushConfigForTests(): void {
  cached = null;
}
