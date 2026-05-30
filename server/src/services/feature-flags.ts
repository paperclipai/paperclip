import type { Db } from "@paperclipai/db";
import { featureFlags } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

export const FEATURE_FLAG_KEYS = {
  WORKSPACE_RUNTIME_V2: "WORKSPACE_RUNTIME_V2",
} as const;
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[keyof typeof FEATURE_FLAG_KEYS];

export interface FeatureFlagLookup {
  companyId: string;
  key: FeatureFlagKey | string;
  agentId?: string | null;
}

export interface FeatureFlagState {
  enabled: boolean;
  source: "default" | "company" | "agent_override";
}

const DEFAULT_STATE: FeatureFlagState = { enabled: false, source: "default" };

function parseBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "on" || v === "true" || v === "1" || v === "enabled";
  }
  return false;
}

export async function isFeatureFlagEnabled(db: Db, input: FeatureFlagLookup): Promise<FeatureFlagState> {
  const rows = await db
    .select()
    .from(featureFlags)
    .where(and(eq(featureFlags.companyId, input.companyId), eq(featureFlags.key, input.key)))
    .limit(1);
  const row = rows[0];
  if (!row) return DEFAULT_STATE;

  if (input.agentId) {
    const overrides = row.agentOverrides ?? {};
    if (Object.prototype.hasOwnProperty.call(overrides, input.agentId)) {
      return {
        enabled: parseBool(overrides[input.agentId]),
        source: "agent_override",
      };
    }
  }

  return { enabled: parseBool(row.enabled), source: "company" };
}

export interface FeatureFlagUpsertInput {
  companyId: string;
  key: FeatureFlagKey | string;
  enabled?: boolean;
  agentOverrides?: Record<string, boolean> | null;
  metadata?: Record<string, unknown> | null;
}

export async function upsertFeatureFlag(db: Db, input: FeatureFlagUpsertInput): Promise<void> {
  const existing = await db
    .select()
    .from(featureFlags)
    .where(and(eq(featureFlags.companyId, input.companyId), eq(featureFlags.key, input.key)))
    .limit(1);
  const now = new Date();

  if (existing.length === 0) {
    await db.insert(featureFlags).values({
      companyId: input.companyId,
      key: input.key,
      enabled: input.enabled ? "on" : "off",
      agentOverrides: input.agentOverrides ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  await db
    .update(featureFlags)
    .set({
      ...(input.enabled === undefined ? {} : { enabled: input.enabled ? "on" : "off" }),
      ...(input.agentOverrides === undefined ? {} : { agentOverrides: input.agentOverrides }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      updatedAt: now,
    })
    .where(and(eq(featureFlags.companyId, input.companyId), eq(featureFlags.key, input.key)));
}
