import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  STATE_MANIFEST,
  resolvePaperclipHomeDir,
  resolvePaperclipInstancePath,
  type StateClassEntry,
  type StateManifestContext,
} from "@paperclipai/shared";
import type { StorageProvider } from "../storage/types.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_MAGIC = Buffer.from("PCSTATE1");

export interface StateSnapshotEncryptionProvider {
  id: string;
  encrypt(inputPath: string, outputPath: string): Promise<void>;
  decrypt(inputPath: string, outputPath: string): Promise<void>;
}

export function createAesStateSnapshotEncryptionProvider(key: Buffer): StateSnapshotEncryptionProvider {
  if (key.length !== 32) throw new Error("State snapshot encryption key must be exactly 32 bytes.");
  return {
    id: "aes-256-gcm",
    async encrypt(inputPath, outputPath) {
      const iv = Buffer.from(cryptoRandom(12));
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      await fs.writeFile(outputPath, Buffer.concat([SNAPSHOT_MAGIC, iv]));
      await pipeline(createReadStream(inputPath), cipher, createWriteStream(outputPath, { flags: "a" }));
      await fs.appendFile(outputPath, cipher.getAuthTag());
    },
    async decrypt(inputPath, outputPath) {
      const stat = await fs.stat(inputPath);
      const handle = await fs.open(inputPath, "r");
      try {
        const header = Buffer.alloc(SNAPSHOT_MAGIC.length + 12);
        await handle.read(header, 0, header.length, 0);
        if (!header.subarray(0, SNAPSHOT_MAGIC.length).equals(SNAPSHOT_MAGIC)) throw new Error("Invalid state snapshot header.");
        const tag = Buffer.alloc(16);
        await handle.read(tag, 0, tag.length, stat.size - tag.length);
        const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(SNAPSHOT_MAGIC.length));
        decipher.setAuthTag(tag);
        await pipeline(createReadStream(inputPath, { start: header.length, end: stat.size - tag.length - 1 }), decipher, createWriteStream(outputPath));
      } finally {
        await handle.close();
      }
    },
  };
}

function cryptoRandom(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

async function exists(target: string): Promise<boolean> {
  try { await fs.access(target); return true; } catch { return false; }
}

async function expandPattern(pattern: string): Promise<string[]> {
  const parsed = path.parse(pattern);
  const segments = pattern.slice(parsed.root.length).split(path.sep);
  let current = [parsed.root];
  for (const segment of segments) {
    if (!segment.includes("*")) {
      current = current.map((base) => path.join(base, segment));
      continue;
    }
    const next: string[] = [];
    for (const base of current) {
      if (!(await exists(base))) continue;
      const names = await fs.readdir(base);
      const regex = new RegExp(`^${segment.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`);
      for (const name of names) if (regex.test(name)) next.push(path.join(base, name));
    }
    current = next;
  }
  const found: string[] = [];
  for (const candidate of current) if (await exists(candidate)) found.push(candidate);
  return found;
}

async function copyEntry(entry: StateClassEntry, source: string, destination: string): Promise<void> {
  const stat = await fs.stat(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (entry.consistency === "sqlite_backup" && stat.isFile() && /\.(sqlite|sqlite3|db)$/i.test(source)) {
    await execFileAsync("sqlite3", [source, `.backup '${destination.replace(/'/g, "''")}'`]);
    return;
  }
  await fs.cp(source, destination, { recursive: true, preserveTimestamps: true });
}

export type InstanceStateSnapshotResult = {
  objectKey: string;
  sizeBytes: number;
  sha256: string;
  entryCount: number;
  startedAt: string;
  finishedAt: string;
};

export function createInstanceStateSnapshotService(opts: {
  storageProvider: StorageProvider;
  encryptionProvider: StateSnapshotEncryptionProvider;
  context?: StateManifestContext;
  markerDir?: string;
  manifest?: readonly StateClassEntry[];
}) {
  const context = opts.context ?? {};
  const homeRoot = resolvePaperclipHomeDir(context.homeDir);
  const userRoot = os.homedir();
  const markerDir = opts.markerDir ?? resolvePaperclipInstancePath(context, "data", "instance-backups");
  const manifest = opts.manifest ?? STATE_MANIFEST;

  async function runSnapshot(): Promise<InstanceStateSnapshotResult> {
    const startedAt = new Date();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-state-snapshot-"));
    try {
      const stageDir = path.join(tempDir, "stage");
      let entryCount = 0;
      for (const entry of manifest) {
        if (entry.disposition === "db" || entry.disposition === "cache" || entry.disposition === "ephemeral") continue;
        for (const pattern of entry.resolve(context)) {
          for (const source of await expandPattern(pattern)) {
            const root = source === homeRoot || source.startsWith(homeRoot + path.sep) ? homeRoot : userRoot;
            const rootName = root === homeRoot ? "paperclip-home" : "user-home";
            await copyEntry(entry, source, path.join(stageDir, rootName, path.relative(root, source)));
            entryCount += 1;
          }
        }
      }
      await fs.writeFile(path.join(stageDir, "snapshot-manifest.json"), JSON.stringify({ version: 1, createdAt: startedAt.toISOString(), entries: manifest.map(({ resolve: _resolve, ...entry }) => entry) }, null, 2));
      const archivePath = path.join(tempDir, "snapshot.tar.gz");
      await execFileAsync("tar", ["-czf", archivePath, "-C", stageDir, "."]);
      const encryptedPath = `${archivePath}.enc`;
      await opts.encryptionProvider.encrypt(archivePath, encryptedPath);
      const body = await fs.readFile(encryptedPath);
      const objectKey = `instance-state/${context.instanceId ?? "default"}/${startedAt.toISOString().replace(/[:.]/g, "-")}.tar.gz.enc`;
      await opts.storageProvider.putObject({ objectKey, body, contentType: "application/vnd.paperclip.state-snapshot", contentLength: body.length });
      const result = { objectKey, sizeBytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), entryCount, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString() };
      await fs.mkdir(markerDir, { recursive: true });
      await fs.writeFile(path.join(markerDir, "state-snapshot.success.json"), JSON.stringify(result));
      await fs.rm(path.join(markerDir, "state-snapshot.failure"), { force: true });
      return result;
    } catch (error) {
      await fs.mkdir(markerDir, { recursive: true });
      await fs.writeFile(path.join(markerDir, "state-snapshot.failure"), `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async function restoreSnapshot(objectKey: string): Promise<void> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-state-restore-"));
    try {
      const encryptedPath = path.join(tempDir, "snapshot.enc");
      const object = await opts.storageProvider.getObject({ objectKey });
      await pipeline(object.stream, createWriteStream(encryptedPath));
      const archivePath = path.join(tempDir, "snapshot.tar.gz");
      await opts.encryptionProvider.decrypt(encryptedPath, archivePath);
      const extractDir = path.join(tempDir, "extract");
      await fs.mkdir(extractDir);
      await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir, "--no-same-owner", "--no-same-permissions"]);
      for (const [name, root] of [["paperclip-home", homeRoot], ["user-home", userRoot]] as const) {
        const source = path.join(extractDir, name);
        if (await exists(source)) await fs.cp(source, root, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  return { runSnapshot, restoreSnapshot };
}
