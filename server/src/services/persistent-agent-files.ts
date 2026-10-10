import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, environments, instanceSettings, type Db } from "@paperclipai/db";
import { computerService } from "../modules/computers/index.js";
import { HttpError } from "../errors.js";
import { instructionPath } from "./agent-instruction-files.js";

/** An assignment selects authority, never an arbitrary path supplied by a caller.
 * The computer service separately checks the company attachment and placement. */
export async function persistentAgentFiles(db: Db, companyId: string, agentId: string, environmentId?: string) {
  let selected = environmentId;
  if (!selected) {
    const [agent] = await db.select({ environmentId: agents.defaultEnvironmentId }).from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    if (!agent) return null;
    selected = agent.environmentId ?? undefined;
  }
  if (!selected) {
    const [settings] = await db.select({ environmentId: instanceSettings.defaultEnvironmentId }).from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"));
    selected = settings?.environmentId ?? undefined;
  }
  if (!selected) return null;
  const [environment] = await db.select({ driver: environments.driver, config: environments.config }).from(environments)
    .where(eq(environments.id, selected));
  if (environment?.driver !== "computer" || environment.config.provider !== "boat") return null;
  return computerFileAccess(() => computerService(db).files({ companyId, agentId, environmentId: selected! }));
}

export function isMissingRemoteFile(error: unknown) {
  const value = error as { status?: number; code?: string };
  return value?.status === 404 || value?.code === "not_found";
}

export async function readPersistentAgentFile(files: NonNullable<Awaited<ReturnType<typeof persistentAgentFiles>>>, relative: string) {
  try { return await files.readBytes(instructionPath(relative)); }
  catch (error) { if (isMissingRemoteFile(error)) return null; throw error; }
}

/** Inspect remote bytes without downloading them or applying the editor read cap. */
export async function hashPersistentAgentFile(files: NonNullable<Awaited<ReturnType<typeof persistentAgentFiles>>>, relative: string) {
  try { return await files.hash(instructionPath(relative)); }
  catch (error) { if (isMissingRemoteFile(error)) return null; throw error; }
}

/** First attachment only. Existing directories are adopted, including empty ones.
 * Later turns never read/upload the controller copy of personal files. */
export async function seedPersistentAgentHome(files: NonNullable<Awaited<ReturnType<typeof persistentAgentFiles>>>, localRoot: string) {
  try { await files.listPage("", { limit: 1 }); return; }
  catch (error) { if (!isMissingRemoteFile(error)) throw error; }
  const seed: Record<string, Buffer> = {};
  let total = 0, count = 0;
  async function walk(relative: string) {
    const entries = await fs.readdir(path.join(localRoot, relative), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && relative === "") return [];
      throw error;
    });
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      instructionPath(name);
      if (++count > 100_000) throw new Error("Initial agent folder exceeds its entry limit");
      const stat = await fs.lstat(path.join(localRoot, name));
      if (stat.isDirectory()) await walk(name);
      else if (stat.isFile() && stat.nlink === 1) {
        total += stat.size;
        if (stat.size > 256 * 1024 * 1024 || total > 2 * 1024 * 1024 * 1024) throw new Error("Initial agent folder exceeds its storage limit");
        seed[name] = await fs.readFile(path.join(localRoot, name));
      } else throw new Error("Agent folders cannot contain links or special files");
    }
  }
  await walk("");
  await files.seedBytes(seed);
}

/** Translate the domain's transport-neutral errors at the HTTP service edge. */
export async function computerFileAccess<T extends object>(open: () => Promise<T>): Promise<T> {
  function translate(error: unknown): never {
    const code = (error as { code?: string })?.code;
    const status = code === "not_found" ? 404 : code === "forbidden" ? 403 : code === "conflict" ? 409
      : code === "invalid" ? 422 : code === "provider_error" ? 502 : null;
    if (status) throw new HttpError(status, error instanceof Error ? error.message : "Computer file operation failed", {
      code: code === "conflict" ? "AGENT_FILE_CONFLICT" : code,
    });
    throw error;
  }
  let access: T;
  try { access = await open(); } catch (error) { return translate(error); }
  return new Proxy(access, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try { return await value.apply(target, args); } catch (error) { return translate(error); }
      };
    },
  });
}
