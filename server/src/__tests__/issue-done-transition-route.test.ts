import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import { applyPendingMigrations, companies, createDb, ensurePostgresDatabase } from "@paperclipai/db";
import { createApp } from "../app.js";
import { issueService } from "../services/issues.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

describe("issue done transition route", () => {
  let databaseDir = "";
  let storageDir = "";
  let databaseUrl = "";
  let embeddedPostgres: EmbeddedPostgres;
  let db: ReturnType<typeof createDb>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let companyId = "";
  let codeLabelId = "";

  beforeAll(async () => {
    databaseDir = await mkdtemp(join(tmpdir(), "paperclip-issue-done-route-db-"));
    storageDir = await mkdtemp(join(tmpdir(), "paperclip-issue-done-route-storage-"));
    const port = await detectPort(55434);
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });

    await embeddedPostgres.initialise();
    await embeddedPostgres.start();

    const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "paperclip");

    databaseUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(databaseUrl);

    db = createDb(databaseUrl);
    companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Issue Done Transition Route Test Company",
      issuePrefix: "TDR",
    });

    const issues = issueService(db);
    const codeLabel = await issues.createLabel(companyId, {
      name: "code",
      color: "#64748b",
    });
    codeLabelId = codeLabel.id;

    app = await createApp(db, {
      uiMode: "none",
      storageService: createStorageService(createLocalDiskStorageProvider(storageDir)),
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: false,
      companyDeletionEnabled: false,
    });
  }, 120000);

  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await embeddedPostgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }, 120000);

  async function createCodeIssue() {
    return issueService(db).create(companyId, {
      title: `Code issue ${randomUUID()}`,
      status: "todo",
      priority: "high",
      labelIds: [codeLabelId],
    });
  }

  it("rejects done transitions for code issues without GitHub evidence", async () => {
    const issue = await createCodeIssue();

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Implemented locally." });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("latest completion comment must include a GitHub commit or pull request link");
    expect(res.body.details).toMatchObject({
      requiredLabel: "code",
      fallback: {
        nonCode: "Remove the code label before marking done when the task did not require repository changes.",
      },
    });
  });

  it("allows done when the same patch removes the code label", async () => {
    const issue = await createCodeIssue();

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", labelIds: [] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.labelIds).toEqual([]);
  });

  it("allows done without a new comment when the latest existing comment has a GitHub link", async () => {
    const issue = await createCodeIssue();
    await issueService(db).addComment(
      issue.id,
      "Shipped in https://github.com/acme/paperclip/commit/abc1234",
      { userId: "local-board" },
    );

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });
});
