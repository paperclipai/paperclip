import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  let uiLabelId = "";

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
    const uiLabel = await issues.createLabel(companyId, {
      name: "ui",
      color: "#0f766e",
    });
    uiLabelId = uiLabel.id;

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

  async function createUiIssue() {
    return issueService(db).create(companyId, {
      title: `UI issue ${randomUUID()}`,
      status: "todo",
      priority: "high",
      labelIds: [uiLabelId],
    });
  }

  async function attachImage(issueId: string) {
    return issueService(db).createAttachment({
      issueId,
      provider: "paperclip",
      objectKey: `${issueId}/proof.png`,
      contentType: "image/png",
      byteSize: 1024,
      sha256: "a".repeat(64),
      originalFilename: "proof.png",
      createdByUserId: "local-board",
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

  it("rejects done when commit evidence is local-only (not on remote)", async () => {
    const issue = await createCodeIssue();
    const originalFetch = globalThis.fetch;
    // Mock: commit 404, repo 200 (public) → commit is local-only
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    try {
      const res = await request(app)
        .patch(`/api/issues/${issue.id}`)
        .send({
          status: "done",
          comment: "Done in https://github.com/acme/paperclip/commit/deadbeef1234567",
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("not reachable on the remote repository");
      expect(res.body.details.remoteVerification).toMatchObject({
        result: "unreachable",
        fix: "git push the branch containing the cited commit, then retry the done transition.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it("rejects done transitions for ui issues without screenshot attachments", async () => {
    const issue = await createUiIssue();

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Playwright: 18 passed" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("ui-labeled issues");
    expect(res.body.details).toMatchObject({
      requiredLabel: "ui",
      missing: {
        imageAttachment: true,
        passingPlaywrightEvidence: false,
      },
    });
  });

  it("rejects done transitions for ui issues without passing Playwright evidence", async () => {
    const issue = await createUiIssue();
    await attachImage(issue.id);

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Attached fresh UI screenshots for review." });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("passing Playwright evidence");
    expect(res.body.details).toMatchObject({
      requiredLabel: "ui",
      missing: {
        imageAttachment: false,
        passingPlaywrightEvidence: true,
      },
    });
  });

  it("allows done when the same patch removes the ui label", async () => {
    const issue = await createUiIssue();

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", labelIds: [] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.labelIds).toEqual([]);
  });

  it("allows done for ui issues when image attachments and Playwright evidence already exist", async () => {
    const issue = await createUiIssue();
    await attachImage(issue.id);
    await issueService(db).addComment(
      issue.id,
      "Validation: npx playwright test e2e/ui.spec.ts --project=chromium -> 18 passed",
      { userId: "local-board" },
    );

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });
});
