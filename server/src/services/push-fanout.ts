import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { pushSubscriptionService } from "./push-subscriptions.js";
import { createWebPushTransport, type PushTransport } from "./push-transport.js";

/** Phase 1 allowlist — the only activity action that triggers a push. See SAG-7600 plan §2. */
const ALLOWLISTED_ACTIONS: ReadonlySet<string> = new Set(["issue.thread_interaction_created"]);

export interface PushFanoutActivityContext {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  responsibleUserId: string | null;
  activityLogId: string;
  details: Record<string, unknown> | null;
}

let configuredTransport: PushTransport | null = null;
let warnedNoVapid = false;

export function configurePushFanout(config: {
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
  vapidSubject: string | undefined;
}): void {
  if (config.vapidPublicKey && config.vapidPrivateKey && config.vapidSubject) {
    configuredTransport = createWebPushTransport({
      publicKey: config.vapidPublicKey,
      privateKey: config.vapidPrivateKey,
      subject: config.vapidSubject,
    });
    warnedNoVapid = false;
    return;
  }
  configuredTransport = null;
  if (!warnedNoVapid) {
    warnedNoVapid = true;
    logger.info("push-fanout: VAPID keys not configured — push notifications are a no-op");
  }
}

/** Test-only: inject a mock transport in place of whatever configurePushFanout last set. */
export function setPushTransportForTests(transport: PushTransport | null): void {
  configuredTransport = transport;
}

async function recordFanoutFailures(
  db: Db,
  activityLogId: string,
  failures: ReadonlyArray<{ endpoint: string; error: string }>,
): Promise<void> {
  try {
    const [row] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.id, activityLogId));
    const mergedDetails = { ...(row?.details ?? {}), pushFanoutFailures: failures };
    await db.update(activityLog).set({ details: mergedDetails }).where(eq(activityLog.id, activityLogId));
  } catch (err) {
    logger.warn({ err, activityLogId }, "push-fanout: failed to record delivery failure against activity_log row");
  }
}

function isDeadEndpointStatus(statusCode: unknown): boolean {
  return statusCode === 404 || statusCode === 410;
}

/**
 * Resolves opted-in (subscribed, non-revoked) devices for the activity's
 * responsible user and sends one push per device. Never throws — callers
 * (logActivity) fire this without awaiting, so all errors are swallowed here
 * after being logged / recorded against the origin activity_log row.
 */
export async function firePushFanoutForActivity(
  db: Db,
  ctx: PushFanoutActivityContext,
  transport: PushTransport | null = configuredTransport,
): Promise<void> {
  try {
    if (!ALLOWLISTED_ACTIONS.has(ctx.action)) return;
    if (!ctx.responsibleUserId) return;
    if (!transport) {
      logger.debug({ activityLogId: ctx.activityLogId }, "push-fanout: no transport configured, skipping send");
      return;
    }

    const subs = await pushSubscriptionService(db).listActiveForUser(ctx.companyId, ctx.responsibleUserId);
    if (subs.length === 0) return;

    const payload = {
      title: "Your input is needed",
      body: `Action: ${ctx.action}`,
      data: {
        issueId: ctx.entityType === "issue" ? ctx.entityId : null,
        action: ctx.action,
        interactionId: ctx.details?.interactionId ?? null,
      },
    };

    const failures: Array<{ endpoint: string; error: string }> = [];

    await Promise.all(subs.map(async (sub) => {
      try {
        await transport.send(sub, payload);
      } catch (err) {
        const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
        if (isDeadEndpointStatus(statusCode)) {
          await pushSubscriptionService(db).revokeByEndpoint(sub.endpoint);
        }
        failures.push({ endpoint: sub.endpoint, error: err instanceof Error ? err.message : String(err) });
        logger.warn({ err, activityLogId: ctx.activityLogId, endpoint: sub.endpoint }, "push-fanout: send failed");
      }
    }));

    if (failures.length > 0) {
      await recordFanoutFailures(db, ctx.activityLogId, failures);
    }
  } catch (err) {
    logger.warn({ err, activityLogId: ctx.activityLogId }, "push-fanout: unexpected fanout error");
  }
}
