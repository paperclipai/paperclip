import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assets, companies, createDb, issueAttachments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { issueService } from "../services/issues.js";
import { retainTaskProviderOutputPolicy, taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import type { ImportIssueAttachmentRow } from "../services/import-write-types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Scope = { companyId: string; issueId: string };

function row(scope: Scope, objectKey = `${scope.companyId}/issues/${scope.issueId}/2026/11/05/${randomUUID()}-synthetic.txt`): ImportIssueAttachmentRow {
  return { ...scope, issueCommentId: null, provider: "local_disk", objectKey,
    contentType: "text/plain", byteSize: 9, sha256: "0".repeat(64), originalFilename: "synthetic.txt",
    createdByAgentId: null, createdByUserId: null };
}

const invalidKeys = {
  foreign_company: (s: Scope) => `${randomUUID()}/issues/${s.issueId}/synthetic.txt`,
  foreign_task: (s: Scope) => `${s.companyId}/issues/${randomUUID()}/synthetic.txt`,
  general_asset: (s: Scope) => `${s.companyId}/assets/general/synthetic.txt`,
  draft_asset: (s: Scope) => `${s.companyId}/assets/issues/drafts/synthetic.txt`,
  empty_suffix: (s: Scope) => `${s.companyId}/issues/${s.issueId}/`,
  traversal: (s: Scope) => `${s.companyId}/issues/${s.issueId}/../other/synthetic.txt`,
  dot_segment: (s: Scope) => `${s.companyId}/issues/${s.issueId}/./synthetic.txt`,
  empty_segment: (s: Scope) => `${s.companyId}/issues/${s.issueId}//synthetic.txt`,
  backslash: (s: Scope) => `${s.companyId}/issues/${s.issueId}/folder\\synthetic.txt`,
  encoded_separator: (s: Scope) => `${s.companyId}/issues/${s.issueId}/folder%2fsynthetic.txt`,
  leading_slash: (s: Scope) => `/${s.companyId}/issues/${s.issueId}/synthetic.txt`,
  whitespace: (s: Scope) => `${s.companyId}/issues/${s.issueId}/synthetic.txt `,
  control_character: (s: Scope) => `${s.companyId}/issues/${s.issueId}/synthetic\u0000.txt`,
  trailing_newline: (s: Scope) => `${s.companyId}/issues/${s.issueId}/synthetic.txt\n`,
};

describePostgres("imported attachment storage scope", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  let storage: ReturnType<typeof createStorageService>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-import-attachment-storage-");
    db = createDb(database.connectionString);
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-import-attachment-storage-"));
    storage = createStorageService(createLocalDiskStorageProvider(root));
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function fixture(): Promise<Scope> {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic storage scope", issuePrefix: `S${companyId.slice(0, 8)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic destination" });
    await retainTaskProviderOutputPolicy(db, { companyId, issueId, disposition: "ordinary" });
    return { companyId, issueId };
  }

  async function assertUnchanged(scope: Scope) {
    expect(await db.select().from(assets).where(eq(assets.companyId, scope.companyId))).toHaveLength(0);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, scope.issueId))).toHaveLength(0);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
  }

  it.each(Object.entries(invalidKeys))("rejects %s before persisting a valid batch prefix", async (_name, key) => {
    const scope = await fixture();
    await expect(issueService(db).addImportedAttachments([row(scope), row(scope, key(scope))])).rejects.toMatchObject({ status: 422 });
    await assertUnchanged(scope);
  });

  it.each(["same_company", "foreign_company"] as const)("rejects an actual %s source object without touching its bytes", async variant => {
    const destination = await fixture(), source = variant === "foreign_company" ? await fixture()
      : { companyId: destination.companyId, issueId: randomUUID() };
    if (variant === "same_company") await db.insert(issues).values({ id: source.issueId, companyId: source.companyId, title: "Synthetic source" });
    const body = Buffer.from("Synthetic source bytes");
    const stored = await storage.putFile({ companyId: source.companyId, namespace: `issues/${source.issueId}`,
      originalFilename: "source.txt", contentType: "text/plain", body });
    await expect(issueService(db).addImportedAttachments([{ ...row(destination), ...stored }])).rejects.toMatchObject({ status: 422 });
    await assertUnchanged(destination);
    const object = await storage.getObject(source.companyId, stored.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(body);
  });

  it("retains a newly materialized destination blob across service reconstruction", async () => {
    const scope = await fixture(), body = Buffer.from("Synthetic imported bytes");
    const stored = await storage.putFile({ companyId: scope.companyId, namespace: `issues/${scope.issueId}`,
      originalFilename: "imported.txt", contentType: "text/plain", body });
    await issueService(db).addImportedAttachments([{ ...row(scope), ...stored }]);
    const [attachment] = await issueService(db).listAttachments(scope.issueId);
    const retained = await issueService(db).getAttachmentById(attachment.id);
    expect(retained).toMatchObject({ companyId: scope.companyId, issueId: scope.issueId, ...stored });
    expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
    const reconstructed = createStorageService(createLocalDiskStorageProvider(root));
    const object = await reconstructed.getObject(scope.companyId, stored.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(body);
    const foreign = await fixture();
    await expect(reconstructed.getObject(foreign.companyId, stored.objectKey)).rejects.toMatchObject({ status: 403 });
  });

  it("rolls back rows and denial with the caller without deleting the staged blob", async () => {
    const scope = await fixture(), body = Buffer.from("Synthetic staged bytes");
    const stored = await storage.putFile({ companyId: scope.companyId, namespace: `issues/${scope.issueId}`,
      originalFilename: "staged.txt", contentType: "text/plain", body });
    await expect(db.transaction(async tx => {
      await issueService(tx as unknown as typeof db).addImportedAttachments([{ ...row(scope), ...stored }]);
      expect(await taskForbidsProviderOutput(tx, scope)).toBe(true);
      await assertUnchanged(scope);
      throw new Error("Caller rollback");
    })).rejects.toThrow("Caller rollback");
    await assertUnchanged(scope);
    expect(await storage.headObject(scope.companyId, stored.objectKey)).toMatchObject({ exists: true, contentLength: body.length });
  });
});
