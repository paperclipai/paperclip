import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport } from "./test-embedded-postgres.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping migration runtime tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("resolveMigrationConnection", () => {
  it(
    "refuses to side-start a second embedded postgres when the preferred port belongs to another data dir",
    async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-migration-runtime-"));
      const runningDataDir = path.join(tempRoot, "running-db");
      const resolvedDataDir = path.join(tempRoot, "resolved-db");
      const configPath = path.join(tempRoot, "instance", "config.json");
      const port = await getAvailablePort();
      const EmbeddedPostgres = await getEmbeddedPostgresCtor();
      const instance = new EmbeddedPostgres({
        databaseDir: runningDataDir,
        user: "paperclip",
        password: "paperclip",
        port,
        persistent: true,
        initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
        onLog: () => {},
        onError: () => {},
      });

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: resolvedDataDir,
            embeddedPostgresPort: port,
          },
        }, null, 2),
      );

      process.env.PAPERCLIP_CONFIG = configPath;

      try {
        await instance.initialise();
        await instance.start();

        await expect(resolveMigrationConnection()).rejects.toThrow(
          new RegExp(`Another embedded PostgreSQL instance is already running on port ${port}`),
        );
        expect(fs.existsSync(path.join(resolvedDataDir, "PG_VERSION"))).toBe(false);
      } finally {
        await instance.stop().catch(() => {});
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
