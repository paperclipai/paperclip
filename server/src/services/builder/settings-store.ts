import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { builderProviderSettings } from "@paperclipai/db";
import type {
  BuilderProviderSettings,
  UpdateBuilderProviderSettings,
} from "@paperclipai/shared";
import { secretService } from "../secrets.js";
import { unprocessable } from "../../errors.js";

/**
 * Per-company Builder adapter settings.
 *
 * Uses the same adapter system as agents. Secrets are stored in company_secrets
 * and referenced via adapterConfig.env with secret_ref bindings.
 */

type Row = typeof builderProviderSettings.$inferSelect;

function toSettings(row: Row): BuilderProviderSettings {
  return {
    companyId: row.companyId,
    adapterType: row.adapterType,
    adapterConfig: (row.adapterConfig ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Validate that all secret references in adapterConfig.env belong to the company.
 */
function validateAdapterConfigSecrets(
  companyId: string,
  adapterConfig: Record<string, unknown>,
  secrets: ReturnType<typeof secretService>,
): void {
  const env = adapterConfig.env as Record<string, unknown> | undefined;
  if (!env) return;

  for (const [key, binding] of Object.entries(env)) {
    if (
      typeof binding === "object" &&
      binding !== null &&
      (binding as any).type === "secret_ref"
    ) {
      const secretId = (binding as any).secretId;
      if (typeof secretId !== "string") {
        throw unprocessable(
          `Invalid secret reference in env.${key}: missing secretId`,
        );
      }
      // Secret validation will be done in upsert via async check
    }
  }
}

export function builderProviderSettingsStore(db: Db) {
  const secrets = secretService(db);

  return {
    get: async (companyId: string): Promise<BuilderProviderSettings | null> => {
      const row = await db
        .select()
        .from(builderProviderSettings)
        .where(eq(builderProviderSettings.companyId, companyId))
        .then((rows) => rows[0] ?? null);
      return row ? toSettings(row) : null;
    },

    upsert: async (
      companyId: string,
      input: UpdateBuilderProviderSettings,
    ): Promise<BuilderProviderSettings> => {
      // Validate all secret references belong to this company
      const env = (input.adapterConfig.env as Record<string, unknown>) ?? {};
      for (const [key, binding] of Object.entries(env)) {
        if (
          typeof binding === "object" &&
          binding !== null &&
          (binding as any).type === "secret_ref"
        ) {
          const secretId = (binding as any).secretId;
          if (typeof secretId !== "string") {
            throw unprocessable(
              `Invalid secret reference in env.${key}: missing secretId`,
            );
          }
          const secret = await secrets.getById(secretId);
          if (!secret || secret.companyId !== companyId) {
            throw unprocessable(
              `Secret ${secretId} must belong to the same company`,
            );
          }
        }
      }

      const now = new Date();
      const values = {
        companyId,
        adapterType: input.adapterType,
        adapterConfig: input.adapterConfig,
        updatedAt: now,
      };

      const [row] = await db
        .insert(builderProviderSettings)
        .values({ ...values, createdAt: now })
        .onConflictDoUpdate({
          target: builderProviderSettings.companyId,
          set: values,
        })
        .returning();
      return toSettings(row);
    },
  };
}

export type BuilderProviderSettingsStore = ReturnType<typeof builderProviderSettingsStore>;
