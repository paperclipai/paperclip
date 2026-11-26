import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySkillRepositorySnapshots as snapshots, createDb } from "@paperclipai/db";
import type { StorageService } from "../storage/index.js";
import { migrateLocalSkillPackageObjects } from "./skill-package-storage-migration.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { uniqueIssuePrefix } from "../__tests__/helpers/issue-prefix.js";

vi.mock("./skill-package-store.js", () => ({ skillPackageStore: () => ({ verifyDurable: async () => true }) }));

const support = await getEmbeddedPostgresTestSupport();
const archive = Buffer.from("archive-bytes"), manifest = Buffer.from("{\"files\":[]}");
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const localReceipt = () => ({ provider: "local_disk", archiveKey: `local/${randomUUID()}/files.tar.gz`, manifestKey: `local/${randomUUID()}/manifest.json`,
  archiveBytes: archive.length, archiveSha256: sha(archive), manifestBytes: manifest.length, manifestSha256: sha(manifest) });

const source = {
  provider: "local_disk",
  getObject: async (_companyId: string, key: string) => ({ stream: Readable.from([key.endsWith("manifest.json") ? manifest : archive]) }),
} as unknown as StorageService;

function destination(onPut?: () => Promise<void>) {
  const objects = new Map<string, Buffer>();
  let puts = 0;
  return {
    objects,
    get puts() { return puts; },
    storage: {
      provider: "s3",
      putFile: async (input: { objectKey: string; body: NodeJS.ReadableStream }) => {
        puts++;
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) chunks.push(Buffer.from(chunk as Buffer));
        objects.set(input.objectKey, Buffer.concat(chunks));
        await onPut?.();
      },
      getObject: async (_companyId: string, key: string) => ({ stream: Readable.from([objects.get(key)!]) }),
      deleteObject: async (_companyId: string, key: string) => { objects.delete(key); },
    } as unknown as StorageService,
  };
}

describe.skipIf(!support.supported)("online skill object copy against PostgreSQL", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-object-online-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function snapshot(upload: Record<string, unknown> | null = null) {
    const [company] = await db.insert(companies).values({ name: "Skills", issuePrefix: uniqueIssuePrefix("S") }).returning();
    const receipt = localReceipt();
    const [row] = await db.insert(snapshots).values({ companyId: company!.id, contentHash: randomUUID(), storage: receipt as never,
      upload: upload as never }).returning();
    return { row: row!, receipt };
  }
  const read = async (id: string) => (await db.select().from(snapshots).where(eq(snapshots.id, id)))[0]!;
  const run = (storage: StorageService, after?: string) => migrateLocalSkillPackageObjects(db as never, { source, destination: storage,
    writersStopped: false, online: true, signal: AbortSignal.timeout(30_000), ...(after ? { after } : {}) });

  it("publishes a verified copy while serving and clears the claim", async () => {
    const { row } = await snapshot();
    const target = destination();
    const result = await run(target.storage);
    expect(result.busy).toBe(0);
    const saved = await read(row.id);
    expect(saved.storage).toMatchObject({ provider: "s3", archiveSha256: sha(archive), manifestSha256: sha(manifest) });
    expect(saved.upload).toBeNull();
  });

  it("leaves a row another owner is copying untouched and counts it busy", async () => {
    const held = { token: randomUUID(), provider: "s3", archiveKey: "other/files.tar.gz", manifestKey: "other/manifest.json",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    const { row, receipt } = await snapshot(held);
    const target = destination();
    const result = await run(target.storage, undefined);
    expect(result.busy).toBeGreaterThanOrEqual(1);
    const saved = await read(row.id);
    expect(saved.storage).toEqual(receipt);
    expect(saved.upload).toEqual(held);
  });

  it("never publishes over a receipt that changed during the copy, and the newer receipt stays readable", async () => {
    const { row } = await snapshot();
    const newer = { ...localReceipt(), provider: "s3", archiveKey: "newer/files.tar.gz", manifestKey: "newer/manifest.json" };
    const target = destination(async () => {
      await db.update(snapshots).set({ storage: newer as never }).where(eq(snapshots.id, row.id));
    });
    await db.update(snapshots).set({ upload: null }).where(eq(snapshots.id, row.id));
    const result = await run(target.storage);
    expect(result.busy).toBeGreaterThanOrEqual(1);
    const saved = await read(row.id);
    expect(saved.storage).toEqual(newer);
    expect(saved.upload).toBeNull();
    expect(target.puts).toBe(2);
    expect(target.objects.size).toBe(0);
  });
});
