import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Linux rejects a single argv/env string at MAX_ARG_STRLEN (32 pages, 131072
 * bytes on a 4 KiB page). A wake document around 600 KB hits that limit inside
 * `PAPERCLIP_WAKE_PAYLOAD_JSON` and `spawn` returns E2BIG before the agent
 * starts. Keep inline copies well under that ceiling.
 */
export const PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES = 64 * 1024;
export const PAPERCLIP_WAKE_PAYLOAD_FILE_SCHEMA = "paperclip.wake_payload_file.v1";
export const PAPERCLIP_WAKE_PAYLOAD_FILE_NAME = "paperclip-wake-payload.json";
export const PAPERCLIP_WAKE_PAYLOAD_PATH_ENV = "PAPERCLIP_WAKE_PAYLOAD_PATH";
export const PAPERCLIP_WAKE_PAYLOAD_JSON_ENV = "PAPERCLIP_WAKE_PAYLOAD_JSON";
export const PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH_ENV = "PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RUN_DIR_PREFIXES = ["paperclip-run-", "paperclip-wake-"];

export interface PaperclipWakePayloadDelivery {
  delivery: "absent" | "inline" | "file";
  /** True when this call replaced an oversized environment value with a file. */
  rewritten: boolean;
  bytes: number;
  envBytes: number;
  path: string | null;
  sha256: string | null;
}

export interface PaperclipWakePayloadPointer {
  path: string;
  bytes: number;
  sha256: string;
}

export function formatPaperclipWakePayloadDiagnostic(
  delivery: PaperclipWakePayloadDelivery,
): string {
  return `[paperclip] wake payload delivery=${delivery.delivery} bytes=${delivery.bytes} envBytes=${delivery.envBytes}\n`;
}

export function readPaperclipWakePayloadPointer(
  value: string | null | undefined,
): PaperclipWakePayloadPointer | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== PAPERCLIP_WAKE_PAYLOAD_FILE_SCHEMA) return null;
  if (typeof record.path !== "string" || !path.isAbsolute(record.path)) return null;
  if (typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
    return null;
  }
  if (typeof record.sha256 !== "string" || !SHA256_HEX.test(record.sha256)) return null;
  const keys = Object.keys(record);
  if (keys.length !== 4 || keys.some((key) => !["schema", "path", "bytes", "sha256"].includes(key))) {
    return null;
  }
  return { path: record.path, bytes: record.bytes, sha256: record.sha256 };
}

export function paperclipWakePayloadFileNote(env: {
  PAPERCLIP_WAKE_PAYLOAD_JSON?: string;
}): string {
  const pointer = readPaperclipWakePayloadPointer(env.PAPERCLIP_WAKE_PAYLOAD_JSON);
  if (!pointer) return "";
  return [
    "## Paperclip wake payload file",
    "",
    `The complete wake JSON is in the run file named by PAPERCLIP_WAKE_PAYLOAD_PATH (${pointer.bytes} bytes).`,
    "Read that file before you act. The file is valid JSON and it keeps the full task history.",
    "PAPERCLIP_WAKE_PAYLOAD_JSON is only a small pointer. It is not the task.",
  ].join("\n");
}

export function paperclipWakePayloadRemotePath(runId: string): string {
  const safe = runId.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  if (!safe) throw new Error("Wake payload run id is empty.");
  return `/tmp/paperclip-wake-${safe}.json`;
}

export function paperclipWakePayloadRemoteInstallCommand(remotePath: string): string {
  if (!remotePath.startsWith("/") || remotePath.split("/").includes("..")) {
    throw new Error("Wake payload remote path must be an absolute path inside the target.");
  }
  const quoted = `'${remotePath.replace(/'/g, `'"'"'`)}'`;
  return `cat > ${quoted} && chmod 600 ${quoted}`;
}

export function rewritePaperclipWakePayloadPointerPath(
  env: Record<string, string>,
  agentPath: string,
): void {
  const current = readPaperclipWakePayloadPointer(env[PAPERCLIP_WAKE_PAYLOAD_JSON_ENV]);
  if (!current) throw new Error("Wake payload pointer is missing.");
  const pointer = JSON.stringify({
    schema: PAPERCLIP_WAKE_PAYLOAD_FILE_SCHEMA,
    path: agentPath,
    bytes: current.bytes,
    sha256: current.sha256,
  });
  if (Buffer.byteLength(pointer) > PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES) {
    throw new Error(
      `Wake payload pointer is ${Buffer.byteLength(pointer)} bytes and does not fit in the environment.`,
    );
  }
  env[PAPERCLIP_WAKE_PAYLOAD_PATH_ENV] = agentPath;
  env[PAPERCLIP_WAKE_PAYLOAD_JSON_ENV] = pointer;
}

/**
 * Publish the on-disk wake document to the machine that will execute the
 * agent, then point the environment at that copy. `publish` receives the
 * document bytes and must not place them on an argv list.
 */
export async function retargetPaperclipWakePayloadEnv(input: {
  env: Record<string, string>;
  runId: string;
  publish: (remotePath: string, body: string) => Promise<void>;
}): Promise<boolean> {
  const localPath = input.env[PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH_ENV];
  if (!localPath) return false;
  const body = await fs.readFile(localPath, "utf8");
  const remotePath = paperclipWakePayloadRemotePath(input.runId);
  await input.publish(remotePath, body);
  rewritePaperclipWakePayloadPointerPath(input.env, remotePath);
  delete input.env[PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH_ENV];
  return true;
}

export function paperclipWakePayloadSandboxMounts(
  env: NodeJS.ProcessEnv,
): Array<{ path: string; access: "ro" | "rw" }> {
  const mounts: Array<{ path: string; access: "ro" | "rw" }> = [];
  const add = (dir: string, access: "ro" | "rw") => {
    const resolved = path.resolve(dir);
    if (!isSpecificRunDirectory(resolved)) return;
    if (mounts.some((mount) => mount.path === resolved)) return;
    mounts.push({ path: resolved, access });
  };

  const scratch = typeof env.PAPERCLIP_RUN_SCRATCH_DIR === "string"
    ? env.PAPERCLIP_RUN_SCRATCH_DIR.trim()
    : "";
  if (scratch && path.isAbsolute(scratch)) add(scratch, "rw");

  for (const key of [PAPERCLIP_WAKE_PAYLOAD_PATH_ENV, PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH_ENV]) {
    const value = env[key];
    if (typeof value !== "string" || !path.isAbsolute(value.trim())) continue;
    if (path.basename(value.trim()) !== PAPERCLIP_WAKE_PAYLOAD_FILE_NAME) continue;
    add(path.dirname(value.trim()), "ro");
  }
  return mounts;
}

export async function materializePaperclipWakePayloadEnv(
  env: Record<string, string>,
  options: {
    runId: string;
    scratchDir?: string | null;
    directory?: string | null;
  },
): Promise<PaperclipWakePayloadDelivery> {
  const json = env[PAPERCLIP_WAKE_PAYLOAD_JSON_ENV];
  if (typeof json !== "string" || json.length === 0) {
    return emptyDelivery();
  }
  const bytes = Buffer.byteLength(json);
  const pointer = readPaperclipWakePayloadPointer(json);
  if (pointer && bytes <= PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES) {
    await assertExistingPointer(env, pointer);
    return {
      delivery: "file",
      rewritten: false,
      bytes: pointer.bytes,
      envBytes: bytes,
      path: env[PAPERCLIP_WAKE_PAYLOAD_PATH_ENV] ?? pointer.path,
      sha256: pointer.sha256,
    };
  }
  if (bytes <= PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES) {
    delete env[PAPERCLIP_WAKE_PAYLOAD_PATH_ENV];
    delete env[PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH_ENV];
    return {
      delivery: "inline",
      rewritten: false,
      bytes,
      envBytes: bytes,
      path: null,
      sha256: null,
    };
  }

  const directory = await resolveSpillDirectory(options);
  const filePath = path.join(directory, PAPERCLIP_WAKE_PAYLOAD_FILE_NAME);
  await writeExactFile(filePath, json);
  const sha256 = createHash("sha256").update(json).digest("hex");
  const pointerJson = JSON.stringify({
    schema: PAPERCLIP_WAKE_PAYLOAD_FILE_SCHEMA,
    path: filePath,
    bytes,
    sha256,
  });
  if (Buffer.byteLength(pointerJson) > PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES) {
    throw new Error(
      `Wake payload pointer is ${Buffer.byteLength(pointerJson)} bytes and does not fit in the environment.`,
    );
  }
  env[PAPERCLIP_WAKE_PAYLOAD_JSON_ENV] = pointerJson;
  env[PAPERCLIP_WAKE_PAYLOAD_PATH_ENV] = filePath;
  env[PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH_ENV] = filePath;
  return {
    delivery: "file",
    rewritten: true,
    bytes,
    envBytes: Buffer.byteLength(pointerJson),
    path: filePath,
    sha256,
  };
}

function emptyDelivery(): PaperclipWakePayloadDelivery {
  return {
    delivery: "absent",
    rewritten: false,
    bytes: 0,
    envBytes: 0,
    path: null,
    sha256: null,
  };
}

async function assertExistingPointer(
  env: Record<string, string>,
  pointer: PaperclipWakePayloadPointer,
): Promise<void> {
  const direct = await readFileIfPresent(pointer.path);
  if (direct) {
    assertFileMatchesPointer(direct, pointer);
    env[PAPERCLIP_WAKE_PAYLOAD_PATH_ENV] = pointer.path;
    return;
  }
  const localPath = env[PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH_ENV];
  if (localPath) {
    const local = await readFileIfPresent(localPath);
    if (!local) {
      throw new Error(
        `Wake payload file is missing (${pointer.bytes} bytes). Refusing to start without the full context.`,
      );
    }
    assertFileMatchesPointer(local, pointer);
    return;
  }
}

function assertFileMatchesPointer(file: Buffer, pointer: PaperclipWakePayloadPointer): void {
  const sha256 = createHash("sha256").update(file).digest("hex");
  if (file.byteLength !== pointer.bytes || sha256 !== pointer.sha256) {
    throw new Error(
      `Wake payload file does not match the pointer (file ${file.byteLength} bytes, pointer ${pointer.bytes} bytes). Refusing to start with a different document.`,
    );
  }
}

async function readFileIfPresent(filePath: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return null;
    return await fs.readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function resolveSpillDirectory(options: {
  runId: string;
  scratchDir?: string | null;
  directory?: string | null;
}): Promise<string> {
  const explicit = absoluteDirectory(options.directory) ?? absoluteDirectory(options.scratchDir);
  if (explicit) {
    await fs.mkdir(explicit, { recursive: true });
    return explicit;
  }
  const safe = options.runId.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "run";
  return fs.mkdtemp(path.join(os.tmpdir(), `paperclip-wake-${safe}-`));
}

function absoluteDirectory(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  return path.resolve(trimmed);
}

async function writeExactFile(filePath: string, contents: string): Promise<void> {
  const existing = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    await fs.unlink(filePath);
  }
  await fs.writeFile(filePath, contents, { encoding: "utf8", mode: 0o600, flag: "w" });
  await fs.chmod(filePath, 0o600);
}

function isSpecificRunDirectory(dir: string): boolean {
  const base = path.basename(dir);
  if (!RUN_DIR_PREFIXES.some((prefix) => base.startsWith(prefix))) return false;
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return false;
  return true;
}
