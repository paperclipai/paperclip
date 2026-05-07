import { chmod, mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { arch, platform, tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

type EmbeddedPostgresBinarySet = {
  initdb: string;
  postgres: string;
};

export type EmbeddedPostgresOptions = {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
};

async function loadEmbeddedPostgresBinaries(): Promise<EmbeddedPostgresBinarySet> {
  try {
    const packageEntryUrl = await import.meta.resolve("embedded-postgres");
    const binaryModuleUrl = new URL("./binary.js", packageEntryUrl);
    const mod = await import(binaryModuleUrl.href);
    if (typeof mod.default !== "function") {
      throw new Error("embedded-postgres binary resolver did not export a default function");
    }
    const getBinaries = mod.default as () => Promise<EmbeddedPostgresBinarySet>;
    return getBinaries();
  } catch (err) {
    throw new Error(
      `Failed to resolve embedded PostgreSQL binaries for ${platform()}/${arch()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function ensureExecutable(filePath: string) {
  const fileStat = await stat(filePath);
  const executeMask = 0o111;
  if ((fileStat.mode & executeMask) === executeMask) return;
  await chmod(filePath, fileStat.mode | executeMask);
}

function waitForExit(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

async function canConnect(host: string, port: number) {
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

async function waitForPort(host: string, port: number, timeoutMs: number, child: ChildProcess) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error("Embedded PostgreSQL exited before accepting connections");
    }
    if (await canConnect(host, port)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Embedded PostgreSQL did not accept connections within ${timeoutMs}ms`);
}

export class EmbeddedPostgres {
  private readonly options: EmbeddedPostgresOptions;
  private process: ChildProcess | null = null;

  constructor(options: EmbeddedPostgresOptions) {
    this.options = options;
  }

  async initialise() {
    const { initdb } = await loadEmbeddedPostgresBinaries();
    await ensureExecutable(initdb);
    await mkdir(resolve(this.options.databaseDir, ".."), { recursive: true });

    const passwordFile = resolve(tmpdir(), `paperclip-pg-pass-${randomBytes(8).toString("hex")}.txt`);
    await writeFile(passwordFile, `${this.options.password}\n`, { mode: 0o600 });

    try {
      const args = [
        `--pgdata=${this.options.databaseDir}`,
        "--auth=password",
        `--username=${this.options.user}`,
        `--pwfile=${passwordFile}`,
      ];
      const child = spawn(initdb, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      child.stdout?.on("data", (chunk) => {
        this.options.onLog?.(String(chunk));
      });
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        this.options.onLog?.(text);
        this.options.onError?.(text);
      });

      const { code } = await waitForExit(child);
      if (code !== 0) {
        throw new Error(`Postgres init script exited with code ${code}. Please check the logs for extra info.`);
      }
    } finally {
      await unlink(passwordFile).catch(() => undefined);
    }
  }

  async start() {
    const { postgres } = await loadEmbeddedPostgresBinaries();
    await ensureExecutable(postgres);
    const child = spawn(
      postgres,
      ["-D", this.options.databaseDir, "-p", String(this.options.port)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );
    this.process = child;

    child.stdout?.on("data", (chunk) => {
      this.options.onLog?.(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      this.options.onLog?.(text);
      this.options.onError?.(text);
    });

    child.once("error", (err) => {
      this.options.onError?.(err);
    });

    try {
      await waitForPort("127.0.0.1", this.options.port, 15_000, child);
    } catch (err) {
      child.kill(platform() === "win32" ? undefined : "SIGINT");
      if (this.process === child) {
        this.process = null;
      }
      throw err;
    }
  }

  async stop() {
    const child = this.process;
    if (!child) return;
    this.process = null;

    if (platform() === "win32") {
      child.kill();
    } else {
      child.kill("SIGINT");
    }
    await waitForExit(child).catch(() => undefined);

    if (!this.options.persistent) {
      await rm(this.options.databaseDir, { recursive: true, force: true });
    }
  }
}
