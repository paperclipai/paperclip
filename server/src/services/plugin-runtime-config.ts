import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginConfigRuntime } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Keys that are forbidden at the top level of the config object.
 * Includes prototype-pollution vectors and structural sentinel values.
 */
export const RESERVED_KEYS: readonly string[] = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Maximum byte size of the serialized merged config (64 KiB). */
export const MAX_CONFIG_BYTES = 65536;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that none of the keys in `patch` are reserved or structurally
 * invalid. Throws if any violation is found.
 *
 * Rules:
 *   - Key must not be empty
 *   - Key must not start or end with a dot
 *   - Key must not be in RESERVED_KEYS (after Unicode NFC normalization)
 */
export function validateReservedKeys(patch: Record<string, unknown>): void {
  for (const rawKey of Object.keys(patch)) {
    // Unicode-normalize to catch look-alike proto variants
    const key = rawKey.normalize("NFC");

    if (key === "") {
      throw new Error(`Key is reserved: empty string is not allowed`);
    }

    if (key.startsWith(".") || key.endsWith(".")) {
      throw new Error(
        `Key "${key}" is reserved: keys may not start or end with a dot`,
      );
    }

    if ((RESERVED_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Key "${key}" is reserved and cannot be used`);
    }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface RuntimeConfigResult {
  values: Record<string, unknown>;
  revision: string;
}

export interface RuntimeConfigMutationResult {
  revision: string;
}

/**
 * Service for managing plugin-owned mutable runtime configuration.
 *
 * One row per plugin (enforced by unique index on `plugin_id`). Revision is
 * a bigint serialized as a string to avoid JS number precision loss.
 *
 * All mutating operations are atomic upserts — no SELECT FOR UPDATE races.
 */
export function createPluginRuntimeConfigService(db: Db) {
  // -------------------------------------------------------------------------
  // getRuntime
  // -------------------------------------------------------------------------

  async function getRuntime(pluginId: string): Promise<RuntimeConfigResult> {
    const rows = await db
      .select()
      .from(pluginConfigRuntime)
      .where(eq(pluginConfigRuntime.pluginId, pluginId));

    if (rows.length === 0) {
      return { values: {}, revision: "0" };
    }

    const row = rows[0]!;
    return {
      values: row.configJson as Record<string, unknown>,
      revision: String(row.revision),
    };
  }

  // -------------------------------------------------------------------------
  // setRuntime
  // -------------------------------------------------------------------------

  async function setRuntime(
    pluginId: string,
    patch: Record<string, unknown>,
  ): Promise<RuntimeConfigMutationResult> {
    if (Object.keys(patch).length === 0) {
      throw new Error("patch is empty: at least one key is required");
    }

    validateReservedKeys(patch);

    // Pre-flight size check against last-known state. The revision increment is
    // atomic (conflict handler), but size enforcement is best-effort: a
    // second concurrent writer that passes this check before the first writer
    // commits could push the total slightly past MAX_CONFIG_BYTES. This is
    // acceptable because the plugin worker is single-process-per-plugin by
    // design (see plugin-worker-manager.ts M1 constraint), so true concurrency
    // between two writers for the same pluginId cannot occur in practice.
    const existing = await getRuntime(pluginId);
    const merged: Record<string, unknown> = { ...existing.values, ...patch };

    const serialized = JSON.stringify(merged);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
      throw new Error(
        `Config size limit exceeded: merged config exceeds ${MAX_CONFIG_BYTES} bytes (too large)`,
      );
    }

    // Atomic upsert — revision increment is serialized by the DB constraint
    const rows = await db
      .insert(pluginConfigRuntime)
      .values({
        pluginId,
        configJson: merged,
        revision: 1n,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: pluginConfigRuntime.pluginId,
        set: {
          configJson: sql`${pluginConfigRuntime.configJson} || ${JSON.stringify(patch)}::jsonb`,
          revision: sql`${pluginConfigRuntime.revision} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ revision: pluginConfigRuntime.revision });

    const row = rows[0]!;
    return { revision: String(row.revision) };
  }

  // -------------------------------------------------------------------------
  // unsetRuntime
  // -------------------------------------------------------------------------

  async function unsetRuntime(
    pluginId: string,
    key: string,
  ): Promise<RuntimeConfigMutationResult> {
    validateReservedKeys({ [key]: null });

    const existing = await getRuntime(pluginId);

    if (existing.revision === "0") {
      return { revision: "0" };
    }

    if (!Object.prototype.hasOwnProperty.call(existing.values, key)) {
      // Key not present — no-op, no revision increment
      return { revision: existing.revision };
    }

    // Use SQL key-deletion operator (`-`) to avoid re-serializing the full object
    // in application code. This is safe from read-modify-write loss: the key
    // existence check above runs in the same single-worker-per-plugin context
    // (M1 constraint), so no concurrent writer can add the key between check and update.
    const rows = await db
      .update(pluginConfigRuntime)
      .set({
        configJson: sql`${pluginConfigRuntime.configJson} - ${key}::text`,
        revision: sql`${pluginConfigRuntime.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(pluginConfigRuntime.pluginId, pluginId))
      .returning({ revision: pluginConfigRuntime.revision });

    return { revision: String(rows[0]!.revision) };
  }

  // -------------------------------------------------------------------------
  // clearRuntime
  // -------------------------------------------------------------------------

  async function clearRuntime(pluginId: string): Promise<void> {
    // Unconditional UPDATE: if no row exists, 0 rows affected = safe no-op.
    // Avoids the TOCTOU race where a worker INSERT commits between a pre-read
    // "revision === 0" check and this UPDATE (operator REST path bypasses M1).
    await db
      .update(pluginConfigRuntime)
      .set({
        configJson: {},
        revision: sql`${pluginConfigRuntime.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(pluginConfigRuntime.pluginId, pluginId));
  }

  return { getRuntime, setRuntime, unsetRuntime, clearRuntime };
}
