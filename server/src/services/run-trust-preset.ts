import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import {
  resolveCoreTrustPreset,
  type ResolveCoreTrustPresetInput,
} from "./trust-preset-resolver.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Retain dispatch's effective boundary before exposing any execution capability. */
export async function resolveAndRetainRunTrustPreset(
  db: Db,
  input: Omit<ResolveCoreTrustPresetInput, "run"> & {
    agentId: string;
    runId: string;
  },
) {
  return db.transaction(async (tx) => {
    const scope = and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.status, "running"),
    );
    const [run] = await tx
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(scope)
      .for("update");
    if (!run) throw conflict("Cannot retain policy for an inactive execution");

    // Use the durable run policy, not a caller's possibly stale launch snapshot.
    // Resuming or editing a live policy may tighten this boundary, never erase it.
    const existingPolicy = run.contextSnapshot?.executionPolicy;
    const trustPreset = resolveCoreTrustPreset({
      ...input,
      run: { companyId: input.companyId, executionPolicy: existingPolicy },
    });
    if (trustPreset.kind !== "low_trust_review") {
      return { trustPreset, executionPolicy: existingPolicy };
    }

    const executionPolicy = {
      ...asRecord(existingPolicy),
      trustPreset: trustPreset.preset,
      authorizationPolicy: {
        ...asRecord(asRecord(existingPolicy).authorizationPolicy),
        trustPreset: trustPreset.preset,
        trustBoundary: trustPreset.boundary,
      },
    };
    await tx
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sql`jsonb_set(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb), '{executionPolicy}', ${JSON.stringify(executionPolicy)}::jsonb, true)`,
        updatedAt: new Date(),
      })
      .where(scope);
    return { trustPreset, executionPolicy };
  });
}
