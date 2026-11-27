import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, companySkillRepositorySnapshots as snapshots, createDb } from "@paperclipai/db";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { skillPackageStore } from "../services/skill-package-store.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";

const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureException: captureExceptionMock }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));

const SLOW_DOWN = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message><RequestId>req-503</RequestId></Error>`;

const objects = new Map<string, Buffer>();
const puts: Array<{ key: string; contentMd5: string | undefined }> = [];
let throttledPuts = 0;

function respond(req: IncomingMessage, res: ServerResponse, body: Buffer) {
  const key = decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^\/bucket\//, ""));
  if (req.method === "PUT") {
    puts.push({ key, contentMd5: req.headers["content-md5"] as string | undefined });
    if (throttledPuts > 0) {
      throttledPuts--;
      res.writeHead(503, { "content-type": "application/xml" });
      res.end(SLOW_DOWN);
      return;
    }
    objects.set(key, body);
    res.writeHead(200, { etag: '"saved"' });
    res.end();
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const object = objects.get(key);
    if (!object) {
      res.writeHead(404, { "content-type": "application/xml" });
      res.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    res.writeHead(200, { "content-length": object.length, etag: '"saved"' });
    res.end(req.method === "GET" ? object : undefined);
    return;
  }
  res.writeHead(204);
  res.end();
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", chunk => chunks.push(chunk as Buffer));
  req.on("end", () => respond(req, res, Buffer.concat(chunks)));
});

const files: CompanySkillVersionFileInventoryEntry[] = [
  { path: "skills/one/SKILL.md", kind: "skill", content: "---\nname: one\ndescription: Test one\n---\nUse it.\n" },
];

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("skill package uploads under storage request-rate limits", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let storage: ReturnType<typeof createStorageService>;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.AWS_ACCESS_KEY_ID = "fixture-access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret-key";
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;
    home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-package-throttle-"));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("skill-package-throttle-");
    db = createDb(database.connectionString, { maxConnections: 2 });
    storage = createStorageService(createS3StorageProvider({ bucket: "bucket", region: "us-east-1", endpoint, forcePathStyle: true }));
  });

  beforeEach(() => {
    objects.clear();
    puts.length = 0;
    throttledPuts = 0;
    captureExceptionMock.mockReset();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    process.env = savedEnv;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Throttle test", issuePrefix: `T${id.slice(0, 6)}` });
    return id;
  }

  it("resends the archive after a transient SlowDown and publishes the package", async () => {
    const companyId = await company();
    throttledPuts = 1;

    const id = await skillPackageStore(db, storage).prepare(companyId, files);

    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, id));
    expect(row!.storage?.archiveKey).toBeTruthy();
    const archivePuts = puts.filter(put => put.key.endsWith("files.tar.gz"));
    expect(archivePuts).toHaveLength(2);
    expect(archivePuts.every(put => put.contentMd5)).toBe(true);
  });

  it("answers persistent throttling with 503 and lets the same caller retry at once", async () => {
    const companyId = await company();
    throttledPuts = Number.POSITIVE_INFINITY;
    const store = skillPackageStore(db, storage);
    const app = express();
    app.post("/prepare", async (_req, res) => { res.json({ id: await store.prepare(companyId, files) }); });
    app.use(errorHandler);

    const throttled = await request(app).post("/prepare");

    expect(throttled.status).toBe(503);
    expect(throttled.headers["retry-after"]).toBe("30");
    expect(throttled.body).toEqual({
      error: "File storage is temporarily unavailable or is limiting requests. Try again in a moment.",
      code: "storage_unavailable",
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();

    throttledPuts = 0;
    const retried = await request(app).post("/prepare");

    expect(retried.status).toBe(200);
    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, retried.body.id));
    expect(row!.storage).not.toBeNull();
  });
});
