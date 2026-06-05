import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  prepareEmbeddedPostgresNativeRuntime,
} from "@paperclipai/db";
import { createEmbeddedPostgresSupervisor } from "./embedded-postgres-supervisor.js";

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

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describeEmbeddedPostgres("embedded postgres supervisor [integration]", () => {
  let dataDir = "";
  let port = 0;
  let embedded: EmbeddedPostgresInstance | null = null;
  let conn = "";

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tra244-supervisor-"));
    port = await freePort();
    await prepareEmbeddedPostgresNativeRuntime();
    const mod = await import("embedded-postgres");
    const Ctor = mod.default as EmbeddedPostgresCtor;
    embedded = new Ctor({
      databaseDir: dataDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: () => {},
      onError: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    conn = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  }, 120_000);

  afterAll(async () => {
    if (embedded) await embedded.stop().catch(() => {});
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("recovers from a simulated postgres crash within the budget", async () => {
    if (!embedded) throw new Error("embedded postgres not initialized");

    const preflight = createDb(conn);
    await preflight.execute(sql`SELECT 1`);

    await embedded.stop();

    let postFailed = false;
    try {
      const probe = createDb(conn);
      await probe.execute(sql`SELECT 1`);
    } catch {
      postFailed = true;
    }
    expect(postFailed).toBe(true);

    const supervisor = createEmbeddedPostgresSupervisor({
      embeddedPostgres: embedded,
      dataDir,
      port,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await supervisor.recoverIfUnhealthy("health");

    const recovered = createDb(conn);
    const rows = (await recovered.execute(sql`SELECT 1 AS one`)) as Array<{ one: number }>;
    expect(Number(rows[0]?.one)).toBe(1);
  }, 180_000);
});
