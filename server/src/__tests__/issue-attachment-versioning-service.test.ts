import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assets,
  companies,
  createDb,
  issueAttachments,
  issueLabels,
  issues,
  labels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue attachment versioning", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attachment-version-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueAttachments);
    await db.delete(issueLabels);
    await db.delete(assets);
    await db.delete(labels);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
    await tempDb?.cleanup();
  });

  async function withDelayedAttachmentDelete<T>(
    callback: () => Promise<T>,
    delaySeconds = 0.2,
  ): Promise<T> {
    await db.execute(sql.raw(`
      CREATE FUNCTION "delay_attachment_delete_fn"() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(${delaySeconds});
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER "delay_attachment_delete"
      BEFORE DELETE ON "issue_attachments"
      FOR EACH ROW EXECUTE FUNCTION "delay_attachment_delete_fn"()
    `));
    try {
      return await callback();
    } finally {
      await db.execute(sql.raw(
        'DROP TRIGGER IF EXISTS "delay_attachment_delete" ON "issue_attachments"',
      ));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS "delay_attachment_delete_fn"()'));
    }
  }

  async function waitForSleepingAttachmentDelete() {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = Array.from(await db.execute(sql<{ sleeping: number | string }>`
        SELECT count(*)::int AS sleeping
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Timeout'
          AND wait_event = 'PgSleep'
          AND query ILIKE '%delete from "issue_attachments"%'
      `));
      if (Number(rows[0]?.sleeping ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for sleeping attachment delete");
  }

  async function withDelayedIssueLabelInsert<T>(callback: () => Promise<T>): Promise<T> {
    await db.execute(sql.raw(`
      CREATE FUNCTION "delay_issue_label_insert_fn"() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.25);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER "delay_issue_label_insert"
      BEFORE INSERT ON "issue_labels"
      FOR EACH ROW EXECUTE FUNCTION "delay_issue_label_insert_fn"()
    `));
    try {
      return await callback();
    } finally {
      await db.execute(sql.raw(
        'DROP TRIGGER IF EXISTS "delay_issue_label_insert" ON "issue_labels"',
      ));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS "delay_issue_label_insert_fn"()'));
    }
  }

  async function waitForSleepingIssueLabelInsert() {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = Array.from(await db.execute(sql<{ sleeping: number | string }>`
        SELECT count(*)::int AS sleeping
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Timeout'
          AND wait_event = 'PgSleep'
          AND query ILIKE '%insert into "issue_labels"%'
      `));
      if (Number(rows[0]?.sleeping ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for sleeping issue label insert");
  }

  async function waitForBlockedLabelDelete() {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = Array.from(await db.execute(sql<{ blocked: number | string }>`
        SELECT count(*)::int AS blocked
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND (
            query ILIKE '%delete from "labels"%'
            OR query ILIKE '%from "labels"%for update%'
          )
      `));
      if (Number(rows[0]?.blocked ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for blocked label delete");
  }

  async function waitForBlockedIssueVersionUpdate(timeoutMs = 300): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = Array.from(await db.execute(sql<{ blocked: number | string }>`
        SELECT count(*)::int AS blocked
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%update "issues"%'
      `));
      if (Number(rows[0]?.blocked ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  it("advances once for create and remove while preserving no-op versions", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "ATT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Attachment versioning",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "ATT-1",
    });

    const attachment = await svc.createAttachment({
      issueId,
      provider: "local_disk",
      objectKey: `${companyId}/issues/${issueId}/artifact.txt`,
      contentType: "text/plain",
      byteSize: 4,
      sha256: "deadbeef",
      originalFilename: "artifact.txt",
      createdByUserId: "board-user",
    });
    const [afterCreate] = await db
      .select({ version: issues.version })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(afterCreate.version).toBe(2);

    await expect(svc.removeAttachment(attachment.id)).resolves.not.toBeNull();
    const [afterRemove] = await db
      .select({ version: issues.version })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(afterRemove.version).toBe(3);

    await expect(svc.removeAttachment(attachment.id)).resolves.toBeNull();
    const [afterNoop] = await db
      .select({ version: issues.version })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(afterNoop.version).toBe(3);
  });

  it("serializes concurrent attachment deletes into one aggregate mutation", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "ATC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Concurrent attachment delete",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "ATC-1",
    });
    const attachment = await svc.createAttachment({
      issueId,
      provider: "local_disk",
      objectKey: `${companyId}/issues/${issueId}/concurrent.txt`,
      contentType: "text/plain",
      byteSize: 4,
      sha256: "deadbeef",
      originalFilename: "concurrent.txt",
      createdByUserId: "board-user",
    });

    const results = await withDelayedAttachmentDelete(async () =>
      await Promise.all([
        svc.removeAttachment(attachment.id),
        svc.removeAttachment(attachment.id),
      ]),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const [afterRemove] = await db
      .select({ version: issues.version })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(afterRemove.version).toBe(3);
  });

  it("avoids deadlock between attachment removal and issue removal", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "ATR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Attachment issue removal",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "ATR-1",
    });
    const attachment = await svc.createAttachment({
      issueId,
      provider: "local_disk",
      objectKey: `${companyId}/issues/${issueId}/remove.txt`,
      contentType: "text/plain",
      byteSize: 4,
      sha256: "deadbeef",
      originalFilename: "remove.txt",
      createdByUserId: "board-user",
    });

    const [removedAttachment, removedIssue] = await withDelayedAttachmentDelete(
      async () => {
        const attachmentRemoval = svc.removeAttachment(attachment.id);
        await waitForSleepingAttachmentDelete();
        const issueRemoval = svc.remove(issueId);
        return await Promise.all([attachmentRemoval, issueRemoval]);
      },
      1.5,
    );

    expect(removedAttachment).not.toBeNull();
    expect(removedIssue).not.toBeNull();
    await expect(
      db.select({ id: assets.id }).from(assets).where(eq(assets.id, attachment.assetId)),
    ).resolves.toEqual([]);
  }, 15_000);

  it("advances every affected issue when deleting a shared label", async () => {
    const companyId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const labelId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "LBL",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "First labeled issue",
        status: "todo",
        priority: "medium",
        issueNumber: 1,
        identifier: "LBL-1",
      },
      {
        id: secondIssueId,
        companyId,
        title: "Second labeled issue",
        status: "todo",
        priority: "medium",
        issueNumber: 2,
        identifier: "LBL-2",
      },
    ]);
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "shared",
      color: "#ff0000",
    });
    await db.insert(issueLabels).values([
      { issueId: firstIssueId, labelId, companyId },
      { issueId: secondIssueId, labelId, companyId },
    ]);

    await expect(svc.deleteLabel(labelId)).resolves.not.toBeNull();
    const afterDelete = await db
      .select({ id: issues.id, version: issues.version })
      .from(issues)
      .where(inArray(issues.id, [firstIssueId, secondIssueId]));
    expect(afterDelete.map((issue) => issue.version)).toEqual([2, 2]);

    await expect(svc.deleteLabel(labelId)).resolves.toBeNull();
    const afterNoop = await db
      .select({ version: issues.version })
      .from(issues)
      .where(inArray(issues.id, [firstIssueId, secondIssueId]));
    expect(afterNoop.map((issue) => issue.version)).toEqual([2, 2]);
  });

  it("includes associations added before a blocked label delete", async () => {
    const companyId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const labelId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "LBC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "First issue",
        status: "todo",
        priority: "medium",
        issueNumber: 1,
        identifier: "LBC-1",
      },
      {
        id: secondIssueId,
        companyId,
        title: "Second issue",
        status: "todo",
        priority: "medium",
        issueNumber: 2,
        identifier: "LBC-2",
      },
    ]);
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "blocked-delete",
      color: "#ff0000",
    });
    await db.insert(issueLabels).values({
      issueId: firstIssueId,
      labelId,
      companyId,
    });

    let releaseLabelLock = () => {};
    let signalLabelLock = () => {};
    const labelLockReady = new Promise<void>((resolve) => {
      signalLabelLock = resolve;
    });
    const labelLockRelease = new Promise<void>((resolve) => {
      releaseLabelLock = resolve;
    });
    const labelLock = db.transaction(async (tx) => {
      await tx
        .select({ id: labels.id })
        .from(labels)
        .where(eq(labels.id, labelId))
        .for("no key update");
      signalLabelLock();
      await labelLockRelease;
    });
    await labelLockReady;

    let deletion: ReturnType<typeof svc.deleteLabel> | undefined;
    try {
      deletion = svc.deleteLabel(labelId);
      await waitForBlockedLabelDelete();
      await db.insert(issueLabels).values({
        issueId: secondIssueId,
        labelId,
        companyId,
      });
    } finally {
      releaseLabelLock();
      await labelLock;
    }
    if (!deletion) throw new Error("Expected label deletion to start");
    await expect(deletion).resolves.not.toBeNull();

    const afterDelete = await db
      .select({ id: issues.id, version: issues.version })
      .from(issues)
      .where(inArray(issues.id, [firstIssueId, secondIssueId]))
      .orderBy(issues.identifier);
    expect(afterDelete.map((issue) => issue.version)).toEqual([2, 2]);
  }, 15_000);

  it("avoids deadlock between label deletion and issue label updates", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const labelId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "LDL",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Label deadlock",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "LDL-1",
    });
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "deadlock",
      color: "#ff0000",
    });
    await db.insert(issueLabels).values({ issueId, labelId, companyId });

    let releaseIssueLock = () => {};
    let signalIssueLock = () => {};
    const issueLockReady = new Promise<void>((resolve) => {
      signalIssueLock = resolve;
    });
    const issueLockRelease = new Promise<void>((resolve) => {
      releaseIssueLock = resolve;
    });
    const update = db.transaction(async (tx) => {
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, issueId))
        .for("update");
      signalIssueLock();
      await issueLockRelease;
      return await svc.update(issueId, { labelIds: [] }, tx);
    });
    await issueLockReady;

    const deletion = svc.deleteLabel(labelId);
    await waitForBlockedIssueVersionUpdate();
    releaseIssueLock();

    const [updated, removed] = await Promise.all([update, deletion]);
    expect(updated).not.toBeNull();
    expect(removed).not.toBeNull();
    const [afterMutation] = await db
      .select({ version: issues.version })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(afterMutation.version).toBe(2);
    await expect(svc.getLabelById(labelId)).resolves.toBeNull();
  }, 15_000);

  it("avoids deadlock when an issue update preserves a deleting label", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const labelId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "LDP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Preserve deleting label",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "LDP-1",
    });
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "preserved",
      color: "#ff0000",
    });
    await db.insert(issueLabels).values({ issueId, labelId, companyId });

    const [updated, removed] = await withDelayedIssueLabelInsert(async () => {
      const update = svc.update(issueId, { labelIds: [labelId] });
      await waitForSleepingIssueLabelInsert();
      const deletion = svc.deleteLabel(labelId);
      return await Promise.all([update, deletion]);
    });

    expect(updated).not.toBeNull();
    expect(removed).not.toBeNull();
    const [afterMutation] = await db
      .select({ version: issues.version })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(afterMutation.version).toBe(3);
    await expect(svc.getLabelById(labelId)).resolves.toBeNull();
    await expect(
      db.select().from(issueLabels).where(eq(issueLabels.issueId, issueId)),
    ).resolves.toEqual([]);
  }, 15_000);
});
