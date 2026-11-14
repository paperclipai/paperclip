import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { listServerAdapters } from "../adapters/registry.js";
import { forbidden } from "../errors.js";
import { resolvePaperclipHomeDir } from "../home-paths.js";
import { getDisabledAdapterTypes, setAdapterDisabled } from "./adapter-plugin-store.js";
import { parseAdapterRegistryEnv } from "./adapter-registry-config.js";
import { isCloudManagedInstance } from "./cloud-instance.js";

const SINGLETON_KEY = "adapter-settings:v1";
let localSettingsMutation: Promise<unknown> = Promise.resolve();
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type AdapterSettingsDb = Pick<Db | Transaction, "select" | "insert" | "update" | "transaction">;
export type StoredAdapterSettings = { version: 1; revision: number; disabledTypes: string[] };
const storedSettingsSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  disabledTypes: z.array(z.string().refine((type) => type.trim().length > 0)),
});

function parseStored(value: Record<string, unknown>): StoredAdapterSettings {
  const parsed = storedSettingsSchema.safeParse(value);
  if (!parsed.success) throw new Error("Persisted adapter settings are invalid");
  return { ...parsed.data, disabledTypes: [...new Set(parsed.data.disabledTypes)].sort() };
}

export function effectiveDisabledAdapterTypes(saved: string[], knownTypes: string[] | (() => string[]), env: Record<string, string | undefined> = process.env): string[] {
  const registry = parseAdapterRegistryEnv(env);
  if (!registry) return [...saved];
  const enabled = new Set(registry.filter((entry) => entry.enabled !== false).map((entry) => entry.adapterType));
  const types = typeof knownTypes === "function" ? knownTypes() : knownTypes;
  return [...new Set(types.filter((type) => !enabled.has(type)))].sort();
}

export function adapterSettingsService(db: AdapterSettingsDb | undefined, options: { runtimeEnv?: Record<string, string | undefined> } = {}) {
  const env = options.runtimeEnv ?? process.env;
  const managed = isCloudManagedInstance(env);

  function requireDb(): AdapterSettingsDb {
    if (!db) throw new Error("A database is required for managed adapter settings");
    return db;
  }

  async function inspectStored(handle: AdapterSettingsDb = requireDb()): Promise<StoredAdapterSettings | null> {
    const [row] = await handle.select({ general: instanceSettings.general }).from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY)).limit(1);
    return row ? parseStored(row.general) : null;
  }

  async function seedIfAbsent(value: { disabledTypes: string[] }, handle: AdapterSettingsDb = requireDb()) {
    const snapshot = parseStored({ version: 1, revision: 0, disabledTypes: value.disabledTypes });
    const inserted = await handle.insert(instanceSettings).values({ singletonKey: SINGLETON_KEY, general: snapshot })
      .onConflictDoNothing({ target: instanceSettings.singletonKey }).returning({ id: instanceSettings.id });
    const current = await inspectStored(handle);
    if (!current) throw new Error("Adapter settings seed was not persisted");
    return { seeded: inserted.length > 0, current };
  }

  return {
    inspectStored,
    seedIfAbsent,
    async getDisabledTypes(): Promise<string[]> {
      const current = managed ? await inspectStored() : null;
      if (managed && !current) throw new Error("Managed adapter settings have not been initialized");
      const stored = managed ? current!.disabledTypes : getDisabledAdapterTypes();
      return effectiveDisabledAdapterTypes(stored, () => listServerAdapters().map((adapter) => adapter.type), env);
    },
    async setDisabled(type: string, disabled: boolean, afterChange?: (handle: AdapterSettingsDb, current: StoredAdapterSettings) => Promise<void>): Promise<boolean> {
      if (!type.trim()) throw new Error("Adapter type is required");
      const registry = parseAdapterRegistryEnv(env);
      if (registry && disabled === registry.some((entry) => entry.adapterType === type && entry.enabled !== false)) {
        throw forbidden("Adapter availability is managed by the hosting operator", { code: "settings_operator_managed" });
      }
      if (!managed) {
        const mutation = localSettingsMutation.then(async () => {
          const previous = getDisabledAdapterTypes().includes(type);
          const changed = setAdapterDisabled(type, disabled);
          if (!changed || !db || !afterChange) return changed;
          try {
            await db.transaction(async (tx) => {
              await afterChange(tx, { version: 1, revision: 0, disabledTypes: getDisabledAdapterTypes() });
            });
          } catch (error) {
            setAdapterDisabled(type, previous);
            throw error;
          }
          return true;
        });
        localSettingsMutation = mutation.catch(() => undefined);
        return mutation;
      }
      return requireDb().transaction(async (tx) => {
        await seedIfAbsent({ disabledTypes: [] }, tx);
        const [row] = await tx.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, SINGLETON_KEY)).for("update");
        if (!row) throw new Error("Adapter settings are unavailable");
        const current = parseStored(row.general);
        const types = new Set(current.disabledTypes);
        if (types.has(type) === disabled) return false;
        if (disabled) types.add(type); else types.delete(type);
        const next: StoredAdapterSettings = { version: 1, revision: current.revision + 1, disabledTypes: [...types].sort() };
        await tx.update(instanceSettings).set({ general: next, updatedAt: new Date() }).where(eq(instanceSettings.id, row.id));
        await afterChange?.(tx, next);
        return true;
      });
    },
  };
}

export type AdapterSettingsService = Pick<ReturnType<typeof adapterSettingsService>, "getDisabledTypes" | "setDisabled">;

export async function initializeAdapterSettings(db: AdapterSettingsDb, options: { runtimeEnv?: Record<string, string | undefined> } = {}) {
  const env = options.runtimeEnv ?? process.env;
  if (!isCloudManagedInstance(env)) return null;
  const service = adapterSettingsService(db, options);
  const current = await service.inspectStored();
  if (current) return { seeded: false, current };
  return service.seedIfAbsent(await readLegacyAdapterSettings(env) ?? { disabledTypes: [] });
}

export async function readLegacyAdapterSettings(env: Record<string, string | undefined> = process.env): Promise<{ disabledTypes: string[] } | null> {
  const filePath = path.join(resolvePaperclipHomeDir(env.PAPERCLIP_HOME), "adapter-settings.json");
  try {
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new Error("Legacy adapter settings exceed the size limit or are not a regular file");
      const buffer = Buffer.alloc(65_537);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > 65_536) throw new Error("Legacy adapter settings exceed the size limit");
      const value = JSON.parse(buffer.subarray(0, total).toString("utf8"));
      return { disabledTypes: parseStored({ version: 1, revision: 0, disabledTypes: value?.disabledTypes }).disabledTypes };
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}
