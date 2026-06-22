import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/**
 * Persisted Web Push subscription store (TON-2312).
 *
 * Subscriptions are stored in a dedicated `instance_settings` row keyed by
 * `singletonKey = "web_push"`, with the payload living in the row's `general`
 * JSONB column. This deliberately avoids a new table/migration: `fork/master`
 * sits behind `origin/master`, so any Drizzle migration collides on
 * `meta/_journal.json` and cannot merge until the fork is synced (see
 * TON-2264). Reusing the singleton-keyed settings table as an isolated KV is
 * the migration-free home; we bypass `instanceSettingsService` on purpose
 * because that service strips unknown keys via a strict zod schema.
 *
 * Follow-up: once the fork is synced and migrations flow again, graduate this
 * to a dedicated `push_subscriptions` table with a per-user index.
 */

const WEB_PUSH_SINGLETON_KEY = "web_push";

export interface StoredPushSubscription {
  /** Board user id that owns this device subscription. */
  userId: string;
  /** Push service endpoint URL (unique per device subscription). */
  endpoint: string;
  /** Encryption keys returned by the browser's PushManager. */
  keys: {
    p256dh: string;
    auth: string;
  };
  /** ISO timestamp the subscription was (re)registered. */
  createdAt: string;
  /** Optional UA string, useful for debugging which device subscribed. */
  userAgent?: string;
}

interface WebPushSettingsBlob {
  subscriptions: StoredPushSubscription[];
}

// --- Pure helpers (unit-tested) -------------------------------------------

/** Insert or replace a subscription, deduped by endpoint. Newest wins. */
export function upsertSubscription(
  list: readonly StoredPushSubscription[],
  next: StoredPushSubscription,
): StoredPushSubscription[] {
  const filtered = list.filter((s) => s.endpoint !== next.endpoint);
  return [...filtered, next];
}

/** Remove every subscription whose endpoint is in `endpoints`. */
export function pruneEndpoints(
  list: readonly StoredPushSubscription[],
  endpoints: readonly string[],
): StoredPushSubscription[] {
  if (endpoints.length === 0) return [...list];
  const drop = new Set(endpoints);
  return list.filter((s) => !drop.has(s.endpoint));
}

function normalizeBlob(raw: unknown): WebPushSettingsBlob {
  if (!raw || typeof raw !== "object") return { subscriptions: [] };
  const subs = (raw as { subscriptions?: unknown }).subscriptions;
  if (!Array.isArray(subs)) return { subscriptions: [] };
  const valid = subs.filter(
    (s): s is StoredPushSubscription =>
      !!s &&
      typeof s === "object" &&
      typeof (s as StoredPushSubscription).userId === "string" &&
      typeof (s as StoredPushSubscription).endpoint === "string" &&
      !!(s as StoredPushSubscription).keys &&
      typeof (s as StoredPushSubscription).keys.p256dh === "string" &&
      typeof (s as StoredPushSubscription).keys.auth === "string",
  );
  return { subscriptions: valid };
}

// --- DB-backed store ------------------------------------------------------

export function pushSubscriptionStore(db: Db) {
  async function readBlob(): Promise<WebPushSettingsBlob> {
    const row = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, WEB_PUSH_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    return normalizeBlob(row?.general);
  }

  async function writeBlob(blob: WebPushSettingsBlob): Promise<void> {
    const now = new Date();
    await db
      .insert(instanceSettings)
      .values({
        singletonKey: WEB_PUSH_SINGLETON_KEY,
        general: blob as unknown as Record<string, unknown>,
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          general: blob as unknown as Record<string, unknown>,
          updatedAt: now,
        },
      });
  }

  return {
    list: async (): Promise<StoredPushSubscription[]> => (await readBlob()).subscriptions,

    listForUser: async (userId: string): Promise<StoredPushSubscription[]> =>
      (await readBlob()).subscriptions.filter((s) => s.userId === userId),

    add: async (sub: StoredPushSubscription): Promise<void> => {
      const blob = await readBlob();
      await writeBlob({ subscriptions: upsertSubscription(blob.subscriptions, sub) });
    },

    removeByEndpoint: async (endpoint: string): Promise<void> => {
      const blob = await readBlob();
      await writeBlob({ subscriptions: pruneEndpoints(blob.subscriptions, [endpoint]) });
    },

    /** Bulk-remove endpoints (used to prune expired/gone subscriptions). */
    removeEndpoints: async (endpoints: readonly string[]): Promise<void> => {
      if (endpoints.length === 0) return;
      const blob = await readBlob();
      await writeBlob({ subscriptions: pruneEndpoints(blob.subscriptions, endpoints) });
    },
  };
}
