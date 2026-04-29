/**
 * Owner / assignee resolution per spec §7.7.
 *
 * Pure email lookup is split from the cached Paperclip-user resolution so the
 * email-finding logic can be unit tested without a plugin context.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  ASSIGNEE_OVERRIDE_ANNOTATION,
  ASSIGNEE_OVERRIDE_LABEL,
  STATE_KEYS,
} from "./constants.js";
import type {
  AlertmanagerAlert,
  OwnerMap,
  OwnerResolution,
} from "./types.js";

/**
 * Resolve which email should own this alert.
 *
 * Resolution order (first hit wins):
 *   1. Direct override label  `alert.labels.paperclip_assignee_email`
 *   2. Owner-map by label key — iterate `ownerMap` (e.g.
 *      `{ team: { platform: "alice@..." }}`) and match against
 *      `alert.labels[key]`.
 *   3. Annotation `paperclip_assignee_email` (same name as 1, just located in
 *      annotations).
 *   4. (V1: not implemented) default per-company on-call.
 *   5. No match → returns `email: null, source: "no-match"`.
 *
 * Pure function; does not touch the host. Returned email is normalized
 * (trimmed + lowercased) so the caller can use it as a cache key directly.
 */
export function resolveOwnerEmail(
  alert: AlertmanagerAlert,
  ownerMap: OwnerMap | undefined,
): OwnerResolution {
  const labelOverride = alert.labels[ASSIGNEE_OVERRIDE_LABEL];
  if (typeof labelOverride === "string" && labelOverride.trim().length > 0) {
    return { email: normalizeEmail(labelOverride), source: "label-override" };
  }

  if (ownerMap) {
    for (const labelKey of Object.keys(ownerMap)) {
      const labelValue = alert.labels[labelKey];
      if (!labelValue) continue;
      const valueMap = ownerMap[labelKey];
      if (!valueMap) continue;
      const email = valueMap[labelValue];
      if (typeof email === "string" && email.trim().length > 0) {
        return { email: normalizeEmail(email), source: "owner-map" };
      }
    }
  }

  const annotationOverride = alert.annotations[ASSIGNEE_OVERRIDE_ANNOTATION];
  if (
    typeof annotationOverride === "string" &&
    annotationOverride.trim().length > 0
  ) {
    return {
      email: normalizeEmail(annotationOverride),
      source: "annotation-override",
    };
  }

  return { email: null, source: "no-match" };
}

/**
 * Cached email → Paperclip user id lookup. Mirror of the Linear plugin's
 * `resolvePaperclipUserIdForEmail` helper (worker.ts:117–140).
 *
 * Cache shape:
 *   `owner-by-email:<normalized-email>` → string user id  (positive)
 *   `owner-by-email:<normalized-email>` → ""              (negative — looked up, no match)
 *   missing                              → never queried
 *
 * `cached === null` (the host's "not set" sentinel) and `cached === ""` are
 * intentionally distinct: the empty string is a real negative cache hit and
 * suppresses a redundant lookup.
 */
export async function resolveOwnerUserId(
  ctx: Pick<PluginContext, "users" | "state" | "logger">,
  email: string | undefined | null,
): Promise<string | undefined> {
  if (!email) return undefined;
  const normalized = normalizeEmail(email);
  if (!normalized) return undefined;

  const stateKey = STATE_KEYS.ownerByEmail(normalized);
  const cached = await ctx.state.get({ scopeKind: "instance", stateKey });
  if (typeof cached === "string" && cached.length > 0) return cached;
  if (cached === "") return undefined;

  try {
    const user = await ctx.users.findByEmail(normalized);
    const userId = user?.id ?? null;
    await ctx.state.set({ scopeKind: "instance", stateKey }, userId ?? "");
    return userId ?? undefined;
  } catch (err) {
    ctx.logger.warn(`Failed to resolve owner ${normalized}: ${String(err)}`);
    return undefined;
  }
}

/**
 * Combined helper: resolve email from alert → cached Paperclip user id.
 * Returns undefined when nothing matches; the caller should still create the
 * issue (unassigned) per §7.7 step 5.
 */
export async function resolveAssigneeUserId(
  ctx: Pick<PluginContext, "users" | "state" | "logger">,
  alert: AlertmanagerAlert,
  ownerMap: OwnerMap | undefined,
): Promise<{ assigneeUserId: string | undefined; resolution: OwnerResolution }> {
  const resolution = resolveOwnerEmail(alert, ownerMap);
  if (!resolution.email) {
    return { assigneeUserId: undefined, resolution };
  }
  const assigneeUserId = await resolveOwnerUserId(ctx, resolution.email);
  return { assigneeUserId, resolution };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
