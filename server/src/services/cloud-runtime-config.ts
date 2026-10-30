import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { paperclipConfigSchema } from "@paperclipai/shared";
import { resolvePaperclipConfigPathForInstance } from "@paperclipai/shared/home-paths";
import { isCloudManagedInstance, type CloudInstanceEnv } from "./cloud-instance.js";
import {
  parseStoredCloudRuntimeConfig,
  projectCloudRuntimeConfig,
  setCloudRuntimeConfigSnapshot,
  type CloudRuntimeConfig,
  type StoredCloudRuntimeConfig,
} from "./cloud-runtime-config-snapshot.js";

export const CLOUD_RUNTIME_CONFIG_KEY = "cloud-runtime-config:v1";
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type CloudRuntimeConfigDb = Pick<Db | Transaction, "select" | "insert" | "update" | "transaction">;

export function cloudRuntimeConfigService(db: CloudRuntimeConfigDb) {
  async function inspectStored(handle: CloudRuntimeConfigDb = db): Promise<StoredCloudRuntimeConfig | null> {
    const [row] = await handle.select({ general: instanceSettings.general }).from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, CLOUD_RUNTIME_CONFIG_KEY)).limit(1);
    return row ? parseStoredCloudRuntimeConfig(row.general) : null;
  }

  async function seedIfAbsent(config: CloudRuntimeConfig | null, handle: CloudRuntimeConfigDb = db) {
    const next = parseStoredCloudRuntimeConfig({ version: 1, revision: 0, config });
    const inserted = await handle.insert(instanceSettings)
      .values({ singletonKey: CLOUD_RUNTIME_CONFIG_KEY, general: next })
      .onConflictDoNothing({ target: instanceSettings.singletonKey }).returning({ id: instanceSettings.id });
    const current = await inspectStored(handle);
    if (!current) throw new Error("Cloud runtime configuration seed was not persisted");
    return { seeded: inserted.length > 0, current };
  }

  return {
    inspectStored,
    seedIfAbsent,
    async replace(config: CloudRuntimeConfig | null, expectedRevision: number, handle: CloudRuntimeConfigDb = db) {
      const validated = parseStoredCloudRuntimeConfig({ version: 1, revision: expectedRevision, config });
      return handle.transaction(async (tx) => {
        const [row] = await tx.select().from(instanceSettings)
          .where(eq(instanceSettings.singletonKey, CLOUD_RUNTIME_CONFIG_KEY)).for("update");
        if (!row) throw new Error("Cloud runtime configuration has not been initialized");
        const current = parseStoredCloudRuntimeConfig(row.general);
        if (current.revision !== expectedRevision) throw new Error("Cloud runtime configuration revision conflict");
        const next = { ...validated, revision: current.revision + 1 };
        await tx.update(instanceSettings).set({ general: next, updatedAt: new Date() }).where(eq(instanceSettings.id, row.id));
        return next;
      });
    },
  };
}

export function legacyCloudRuntimeConfigPath(env: CloudInstanceEnv = process.env): string {
  return env.PAPERCLIP_CONFIG
    ? path.resolve(env.PAPERCLIP_CONFIG)
    : resolvePaperclipConfigPathForInstance({ homeDir: env.PAPERCLIP_HOME, instanceId: env.PAPERCLIP_INSTANCE_ID });
}

export async function readLegacyCloudRuntimeConfig(env: CloudInstanceEnv = process.env): Promise<CloudRuntimeConfig | null> {
  let raw: unknown;
  try {
    const file = await open(legacyCloudRuntimeConfigPath(env), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new Error("invalid file");
      const buffer = Buffer.alloc(65_537);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > 65_536) throw new Error("oversized file");
      raw = JSON.parse(buffer.subarray(0, total).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Legacy Cloud runtime configuration could not be read safely");
    return null;
  }
  const parsed = paperclipConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Legacy Cloud runtime configuration is invalid");
  if (parsed.data.llm?.provider === "openai" && parsed.data.llm.apiKey?.trim() && !env.OPENAI_API_KEY?.trim()) {
    throw new Error("Move the legacy OpenAI API key to OPENAI_API_KEY before initializing Cloud runtime configuration");
  }
  return projectCloudRuntimeConfig(parsed.data);
}

export async function initializeCloudRuntimeConfig(db: CloudRuntimeConfigDb, options: { runtimeEnv?: CloudInstanceEnv } = {}) {
  const env = options.runtimeEnv ?? process.env;
  if (!isCloudManagedInstance(env)) return null;
  setCloudRuntimeConfigSnapshot(null);
  const service = cloudRuntimeConfigService(db);
  const current = await service.inspectStored();
  const result = current
    ? { seeded: false, current }
    : await service.seedIfAbsent(await readLegacyCloudRuntimeConfig(env));
  setCloudRuntimeConfigSnapshot(result.current);
  return result;
}
