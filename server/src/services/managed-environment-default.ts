/**
 * One-time instance default for a managed-config plugin entry that declares
 * `instanceDefault: true` (see `managed-config.ts`).
 *
 * The decision is made once per instance and recorded in its own
 * `instance_settings` row (singleton key `MANAGED_ENVIRONMENT_DEFAULT_DECISION_KEY`,
 * `general` jsonb), so it never re-applies: an admin's later change survives
 * reboots, and removing the flag from the document changes nothing.
 *
 * - First boot that sees the flag: if the instance already has agents, the
 *   default is left alone (`declined`). Otherwise, if the current default is
 *   replaceable (unset, the local row, a dangling id, or a default the managed
 *   sandbox stamped with `managedDefaultStamped`), the entry's row becomes the
 *   default (`applied`). A tenant-chosen default is never replaced.
 * - If the row is not active yet (its plugin is still starting or down), the
 *   decision stays `pending`. When the row becomes active (worker recovery or
 *   a later boot), the default is set only if no agent follows the default
 *   by then and the current default is still replaceable; otherwise the
 *   existing default stays and the decision is `declined`.
 * - An admin's explicit default write ends a decision that has not applied
 *   yet (`cancelPendingManagedEnvironmentDefault`), so recovery never
 *   replaces it.
 */

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, environments, instanceSettings } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";

export const MANAGED_ENVIRONMENT_DEFAULT_DECISION_KEY = "managed-environment-default:v1";
/** Singleton key of the instance settings row that holds `defaultEnvironmentId`. */
const INSTANCE_DEFAULT_SETTINGS_KEY = "default";

export type ManagedEnvironmentDefaultDecisionStatus = "pending" | "applied" | "declined";

export type ManagedEnvironmentDefaultReason =
  | "no_agents"
  | "no_agents_follow_default"
  | "instance_has_agents"
  | "agents_follow_default"
  | "tenant_default"
  | "admin_changed_default"
  | "environment_not_active";

export interface ManagedEnvironmentDefaultDecision {
  version: 1;
  status: ManagedEnvironmentDefaultDecisionStatus;
  reason: ManagedEnvironmentDefaultReason;
  /** The `<pluginKey>:<driverKey>` marker of the entry the decision concerned. */
  environmentMarker: string;
  /** Null when the entry's row did not exist yet (its plugin had not come up). */
  environmentId: string | null;
  previousDefaultEnvironmentId: string | null;
  decidedAt: string;
}

export interface ManagedEnvironmentDefaultOutcome {
  /** `already_decided`: an earlier boot recorded `applied` or `declined`; nothing was evaluated. */
  status: ManagedEnvironmentDefaultDecisionStatus | "already_decided";
  reason: ManagedEnvironmentDefaultReason | null;
  previousDefaultEnvironmentId: string | null;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function readDecision(general: unknown): ManagedEnvironmentDefaultDecision | null {
  if (!general || typeof general !== "object" || Array.isArray(general)) return null;
  const value = general as Partial<ManagedEnvironmentDefaultDecision>;
  if (value.version !== 1) return null;
  if (value.status !== "pending" && value.status !== "applied" && value.status !== "declined") return null;
  return value as ManagedEnvironmentDefaultDecision;
}

/** Read the recorded decision, if any. */
export async function readManagedEnvironmentDefaultDecision(db: Db): Promise<ManagedEnvironmentDefaultDecision | null> {
  const [row] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, MANAGED_ENVIRONMENT_DEFAULT_DECISION_KEY));
  return row ? readDecision(row.general) : null;
}

/**
 * A default the platform may replace: unset, the managed environment itself,
 * a dangling id, the local row, or the managed sandbox while it carries the
 * `managedDefaultStamped` marker (the sandbox stamp, not a tenant choice).
 */
async function isReplaceableDefault(tx: Tx, currentId: string | null, environmentId: string | null): Promise<boolean> {
  if (currentId === null || currentId === environmentId) return true;
  const [current] = await tx
    .select({ driver: environments.driver, metadata: environments.metadata })
    .from(environments)
    .where(eq(environments.id, currentId));
  if (!current || current.driver === "local") return true;
  return current.driver === "sandbox" && (current.metadata as Record<string, unknown> | null)?.managedDefaultStamped === true;
}

/**
 * Evaluate the one-time default for `environment`. Idempotent and safe to
 * call on every boot and on worker recovery.
 */
export async function applyManagedPluginInstanceDefault(
  db: Db,
  input: { environment: { id: string; status: string } | null; marker: string },
): Promise<ManagedEnvironmentDefaultOutcome> {
  // Cheap exit without locks once the decision is final, or while it waits
  // for a row that is still not active.
  const known = await readManagedEnvironmentDefaultDecision(db);
  if (known && known.status !== "pending") {
    return { status: "already_decided", reason: known.reason, previousDefaultEnvironmentId: null };
  }
  if (known?.status === "pending" && input.environment?.status !== "active") {
    return { status: "pending", reason: "environment_not_active", previousDefaultEnvironmentId: null };
  }
  return await db.transaction(async (tx) => {
    const settings = instanceSettingsService(tx as unknown as Db);
    // Lock order, shared with `cancelPendingManagedEnvironmentDefault` (the
    // admin default write): agents, then the instance default row, then the
    // decision row, then any environment row.
    //
    // SHARE on `agents` waits for in-flight agent writes and blocks new ones
    // (inserts, and an agent switching to follow the default) until this
    // transaction commits. So the "no agents" / "no agent follows the
    // default" check below stays true until the new default is visible, and
    // an agent created right after selects its setup plugins against it.
    await tx.execute(sql`lock table ${agents} in share mode`);
    // Lock the instance default row, so an admin's concurrent default write
    // either commits first (and this pass reads it) or waits for this one.
    await settings.get();
    await tx
      .select({ id: instanceSettings.id })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, INSTANCE_DEFAULT_SETTINGS_KEY))
      .for("update");
    // The insert claims the decision for this pass; a concurrent pass waits on
    // the conflict, then reads what this one recorded.
    const claimed = await tx
      .insert(instanceSettings)
      .values({ singletonKey: MANAGED_ENVIRONMENT_DEFAULT_DECISION_KEY, general: {} })
      .onConflictDoNothing({ target: instanceSettings.singletonKey })
      .returning({ id: instanceSettings.id });
    const [row] = await tx
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, MANAGED_ENVIRONMENT_DEFAULT_DECISION_KEY))
      .for("update");
    if (!row) throw new Error("Managed environment default decision was not persisted");
    const recorded = readDecision(row.general);
    const firstEvaluation = claimed.length > 0 || recorded === null;
    if (!firstEvaluation && recorded?.status !== "pending") {
      return { status: "already_decided", reason: recorded?.reason ?? null, previousDefaultEnvironmentId: null };
    }

    const previousDefaultEnvironmentId = (await settings.get()).defaultEnvironmentId ?? null;
    const record = async (
      status: ManagedEnvironmentDefaultDecisionStatus,
      reason: ManagedEnvironmentDefaultReason,
    ): Promise<ManagedEnvironmentDefaultOutcome> => {
      const decision: ManagedEnvironmentDefaultDecision = {
        version: 1,
        status,
        reason,
        environmentMarker: input.marker,
        environmentId: input.environment?.id ?? null,
        previousDefaultEnvironmentId,
        decidedAt: new Date().toISOString(),
      };
      await tx
        .update(instanceSettings)
        .set({ general: decision as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(instanceSettings.id, row.id));
      return { status, reason, previousDefaultEnvironmentId };
    };

    if (firstEvaluation) {
      const [anyAgent] = await tx.select({ id: agents.id }).from(agents).limit(1);
      if (anyAgent) return await record("declined", "instance_has_agents");
    } else {
      // Pending since an earlier pass: the row was not active then. Only an
      // active row can become the default.
      if (input.environment?.status !== "active") {
        return { status: "pending", reason: "environment_not_active", previousDefaultEnvironmentId };
      }
      const [follower] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(isNull(agents.defaultEnvironmentId), ne(agents.status, "terminated")))
        .limit(1);
      if (follower) return await record("declined", "agents_follow_default");
    }

    if (!(await isReplaceableDefault(tx, previousDefaultEnvironmentId, input.environment?.id ?? null))) {
      return await record("declined", "tenant_default");
    }
    const environment = input.environment;
    if (environment?.status !== "active") return await record("pending", "environment_not_active");

    if (previousDefaultEnvironmentId !== environment.id) {
      // The sandbox stamp marker would otherwise let the managed-sandbox revert
      // path attribute a later tenant choice of the sandbox to the platform.
      if (previousDefaultEnvironmentId !== null) {
        await tx
          .update(environments)
          .set({ metadata: sql`${environments.metadata} - 'managedDefaultStamped'` })
          .where(and(
            eq(environments.id, previousDefaultEnvironmentId),
            sql`${environments.metadata} ? 'managedDefaultStamped'`,
          ));
      }
      await settings.update({ defaultEnvironmentId: environment.id }, { db: tx });
    }
    return await record("applied", firstEvaluation ? "no_agents" : "no_agents_follow_default");
  });
}

/**
 * An explicit default write by an admin ends a decision that has not applied
 * yet: a pending decision, or (when the managed config declares an
 * `instanceDefault` entry) one that was never recorded, becomes `declined`
 * with reason `admin_changed_default`, so recovery can never replace the
 * admin's choice later. Call it in the same transaction as the default
 * write, after that write (the instance default row is locked first, as in
 * `applyManagedPluginInstanceDefault`).
 */
export async function cancelPendingManagedEnvironmentDefault(
  tx: Pick<Db, "insert" | "select" | "update">,
  input: { instanceDefaultDeclared: boolean },
): Promise<boolean> {
  if (input.instanceDefaultDeclared) {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: MANAGED_ENVIRONMENT_DEFAULT_DECISION_KEY, general: {} })
      .onConflictDoNothing({ target: instanceSettings.singletonKey });
  }
  const [row] = await tx
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, MANAGED_ENVIRONMENT_DEFAULT_DECISION_KEY))
    .for("update");
  if (!row) return false;
  const recorded = readDecision(row.general);
  if (recorded && recorded.status !== "pending") return false;
  const decision: ManagedEnvironmentDefaultDecision = {
    version: 1,
    status: "declined",
    reason: "admin_changed_default",
    environmentMarker: recorded?.environmentMarker ?? "",
    environmentId: recorded?.environmentId ?? null,
    previousDefaultEnvironmentId: recorded?.previousDefaultEnvironmentId ?? null,
    decidedAt: new Date().toISOString(),
  };
  await tx
    .update(instanceSettings)
    .set({ general: decision as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(instanceSettings.id, row.id));
  return true;
}
