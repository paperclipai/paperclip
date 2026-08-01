import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export const DEFAULT_SERVER_LOG_MAX_BYTES = 500_000_000;
export const DEFAULT_SERVER_LOG_MAX_ARCHIVES = 5;

type RotatingFileStreamOptions = {
  filePath: string;
  maxBytes?: number;
  maxArchives?: number;
  now?: () => Date;
};

function archiveTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function compareArchiveNames(left: string, right: string, baseName: string): number {
  const prefix = `${baseName}.`;
  const parse = (name: string) => {
    const archiveId = name.slice(prefix.length, -3);
    const match = /^(\d{8}T\d{6}Z)(?:\.(\d+))?$/.exec(archiveId);
    return match ? { timestamp: match[1]!, collision: Number.parseInt(match[2] ?? "0", 10) } : null;
  };
  const leftId = parse(left);
  const rightId = parse(right);
  if (!leftId || !rightId) return left.localeCompare(right);
  return leftId.timestamp.localeCompare(rightId.timestamp) || leftId.collision - rightId.collision;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class RotatingFileStream extends Writable {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxArchives: number;
  private readonly now: () => Date;
  private handle: Awaited<ReturnType<typeof open>> | null = null;
  private bytesWritten = 0;
  private initialization: Promise<void> | null = null;
  private maintenanceTail: Promise<void> = Promise.resolve();

  constructor(options: RotatingFileStreamOptions) {
    super({ decodeStrings: true });
    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes ?? DEFAULT_SERVER_LOG_MAX_BYTES;
    this.maxArchives = options.maxArchives ?? DEFAULT_SERVER_LOG_MAX_ARCHIVES;
    this.now = options.now ?? (() => new Date());

    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error("maxBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxArchives) || this.maxArchives <= 0) {
      throw new Error("maxArchives must be a positive safe integer");
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.recoverInterruptedArchives();
    this.handle = await open(this.filePath, "a");
    this.bytesWritten = (await this.handle.stat()).size;
  }

  private async ensureInitialized(): Promise<void> {
    this.initialization ??= this.initialize();
    await this.initialization;
  }

  private async nextArchivePath(): Promise<string> {
    const base = `${this.filePath}.${archiveTimestamp(this.now())}`;
    for (let suffix = 0; ; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}.${suffix}`;
      if (!(await pathExists(candidate)) && !(await pathExists(`${candidate}.gz`))) {
        return candidate;
      }
    }
  }

  private trackCompression(archivePath: string): void {
    this.maintenanceTail = this.maintenanceTail
      .then(() => this.compressArchive(archivePath))
      .then(() => this.pruneArchives())
      .catch((error) => this.reportMaintenanceError(error));
  }

  private async compressArchive(archivePath: string): Promise<void> {
    const compressedPath = `${archivePath}.gz`;
    const temporaryPath = `${compressedPath}.tmp`;
    await unlink(temporaryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await pipeline(
      createReadStream(archivePath),
      createGzip(),
      createWriteStream(temporaryPath, { flags: "wx" }),
    );
    await rename(temporaryPath, compressedPath);
    await unlink(archivePath);
  }

  private async recoverInterruptedArchives(): Promise<void> {
    const directory = path.dirname(this.filePath);
    const baseName = path.basename(this.filePath);
    const names = await readdir(directory);
    for (const name of names) {
      if (!name.startsWith(`${baseName}.`) || name.endsWith(".gz") || name.endsWith(".tmp")) continue;
      this.trackCompression(path.join(directory, name));
    }
  }

  private async pruneArchives(): Promise<void> {
    const directory = path.dirname(this.filePath);
    const baseName = path.basename(this.filePath);
    const archives = (await readdir(directory))
      .filter((name) => name.startsWith(`${baseName}.`) && name.endsWith(".gz"))
      .sort((left, right) => compareArchiveNames(left, right, baseName));
    const stale = archives.slice(0, Math.max(0, archives.length - this.maxArchives));
    await Promise.all(stale.map((name) => unlink(path.join(directory, name))));
  }

  private async rotate(): Promise<void> {
    if (!this.handle) throw new Error("server log file is not open");
    await this.handle.close();
    this.handle = null;

    const archivePath = await this.nextArchivePath();
    await rename(this.filePath, archivePath);

    // Reopen the live path before compression so new log records never follow
    // the renamed inode and a slow gzip cannot block server logging.
    this.handle = await open(this.filePath, "a");
    this.bytesWritten = 0;
    this.trackCompression(archivePath);
  }

  private async writeChunk(chunk: Buffer): Promise<void> {
    await this.ensureInitialized();
    if (this.bytesWritten > 0 && this.bytesWritten + chunk.byteLength > this.maxBytes) {
      await this.rotate();
    }
    if (!this.handle) throw new Error("server log file is not open");

    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(chunk, offset, chunk.byteLength - offset);
      offset += bytesWritten;
    }
    this.bytesWritten += chunk.byteLength;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.writeChunk(buffer).then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    const close = async () => {
      await this.initialization;
      await this.handle?.close();
      this.handle = null;
      await this.waitForMaintenance();
    };
    close().then(() => callback(), callback);
  }

  async waitForMaintenance(): Promise<void> {
    await this.maintenanceTail;
  }

  private reportMaintenanceError(error: unknown): void {
    process.stderr.write(`[paperclip] server log archive maintenance failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
