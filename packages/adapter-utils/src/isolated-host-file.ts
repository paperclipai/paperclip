import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

export function isolatedHostAgentRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME === "true";
}

function isolatedHostAgentUid(env: NodeJS.ProcessEnv): number {
  const uid = Number(env.PAPERCLIP_SECRETS_HOST_AGENT_UID);
  if (process.platform !== "linux" || !Number.isSafeInteger(uid) || uid <= 0 || uid === process.getuid?.()) {
    throw new Error("Isolated host file access requires a separate non-root host agent UID on Linux.");
  }
  return uid;
}

function assertAgentImmutable(stat: import("node:fs").Stats, uid: number): void {
  if (stat.uid === uid || (stat.mode & 0o022) !== 0) {
    throw new Error("Isolated host file access requires agent-immutable files and ancestors.");
  }
}

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// Resolve each component relative to a pinned descriptor. O_NOFOLLOW on the
// final pathname alone does not protect against a swapped ancestor symlink.
async function openImmutableDirectory(absolute: string, uid: number): Promise<FileHandle> {
  let directory = await fs.open("/", DIRECTORY_FLAGS);
  try {
    assertAgentImmutable(await directory.stat(), uid);
    for (const component of absolute.slice(1).split("/").filter(Boolean)) {
      const child = await fs.open(`/proc/self/fd/${directory.fd}/${component}`, DIRECTORY_FLAGS);
      await directory.close();
      directory = child;
      assertAgentImmutable(await directory.stat(), uid);
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

export async function readHostFileForAgent(source: string, env?: NodeJS.ProcessEnv): Promise<Buffer>;
export async function readHostFileForAgent(source: string, encoding: BufferEncoding, env?: NodeJS.ProcessEnv): Promise<string>;
export async function readHostFileForAgent(
  source: string,
  encodingOrEnv?: BufferEncoding | NodeJS.ProcessEnv,
  optionalEnv?: NodeJS.ProcessEnv,
): Promise<Buffer | string> {
  const encoding = typeof encodingOrEnv === "string" ? encodingOrEnv : undefined;
  const env = (typeof encodingOrEnv === "object" ? encodingOrEnv : optionalEnv) ?? process.env;
  if (!isolatedHostAgentRuntimeEnabled(env)) return encoding ? fs.readFile(source, encoding) : fs.readFile(source);
  const uid = isolatedHostAgentUid(env);
  if (!path.isAbsolute(source)) throw new Error("Isolated host file access requires an absolute path.");
  const absolute = path.resolve(source);
  const parent = await openImmutableDirectory(path.dirname(absolute), uid);
  try {
    const file = await fs.open(`/proc/self/fd/${parent.fd}/${path.basename(absolute)}`, FILE_FLAGS);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Isolated host file access requires a regular file.");
      assertAgentImmutable(stat, uid);
      const bytes = await file.readFile();
      return encoding ? bytes.toString(encoding) : bytes;
    } finally {
      await file.close();
    }
  } finally {
    await parent.close();
  }
}

/** Create only under pinned, agent-immutable parents; mkdir -p follows links. */
export async function ensureIsolatedHostDirectory(source: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isolatedHostAgentRuntimeEnabled(env)) {
    await fs.mkdir(source, { recursive: true });
    return;
  }
  const uid = isolatedHostAgentUid(env);
  if (!path.isAbsolute(source)) throw new Error("Isolated host file access requires an absolute path.");
  let directory = await fs.open("/", DIRECTORY_FLAGS);
  try {
    assertAgentImmutable(await directory.stat(), uid);
    for (const component of path.resolve(source).slice(1).split("/").filter(Boolean)) {
      const childPath = `/proc/self/fd/${directory.fd}/${component}`;
      try {
        await fs.mkdir(childPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const child = await fs.open(childPath, DIRECTORY_FLAGS);
      await directory.close();
      directory = child;
      assertAgentImmutable(await directory.stat(), uid);
    }
  } finally {
    await directory.close();
  }
}

/** Check a host asset before a later pathname-based tar/upload in isolation mode. */
export async function assertIsolatedHostAssetDirectory(source: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isolatedHostAgentRuntimeEnabled(env)) return;
  const uid = isolatedHostAgentUid(env);
  if (!path.isAbsolute(source)) throw new Error("Isolated host file access requires an absolute path.");
  const root = await openImmutableDirectory(path.resolve(source), uid);
  async function walk(directory: FileHandle): Promise<void> {
    for (const name of await fs.readdir(`/proc/self/fd/${directory.fd}`)) {
      const entry = await fs.open(`/proc/self/fd/${directory.fd}/${name}`, FILE_FLAGS);
      try {
        const stat = await entry.stat();
        assertAgentImmutable(stat, uid);
        if (stat.isDirectory()) await walk(entry);
        else if (!stat.isFile()) throw new Error("Isolated host asset requires regular files and directories.");
      } finally {
        await entry.close();
      }
    }
  }
  try {
    await walk(root);
  } finally {
    await root.close();
  }
}
