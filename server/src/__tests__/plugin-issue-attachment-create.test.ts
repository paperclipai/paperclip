import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, assets, companies, createDb, issueAttachments, issues } from "@paperclipai/db";
import { PLUGIN_CAPABILITIES } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const stored = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({
    provider: "local_disk",
    async putFile(input: {
      companyId: string;
      namespace: string;
      originalFilename: string | null;
      contentType: string;
      body: Buffer;
    }) {
      const objectKey = `${input.companyId}/${input.namespace}/${randomUUID()}`;
      stored.set(objectKey, input.body);
      return {
        provider: "local_disk",
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: "test-sha",
        originalFilename: input.originalFilename,
      };
    },
    async getObject(_companyId: string, objectKey: string) {
      return { stream: Readable.from([stored.get(objectKey) ?? Buffer.alloc(0)]) };
    },
    async deleteObject(_companyId: string, objectKey: string) {
      stored.delete(objectKey);
    },
  }),
}));

const { buildHostServices } = await import("../services/plugin-host-services.js");
const { MAX_ATTACHMENT_BYTES } = await import("../attachment-types.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin attachment create tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describe("plugin issue attachment create capability", () => {
  it("declares issue.attachments.create as a plugin capability", () => {
    expect(PLUGIN_CAPABILITIES).toContain("issue.attachments.create");
  });
});

describeEmbeddedPostgres("plugin issues.createAttachment host service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-attachment-create-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    stored.clear();
    await db.delete(activityLog);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(visibility: "open" | "private" = "open") {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Feedback",
      status: "backlog",
      priority: "medium",
      visibility,
    });
    return { companyId, issueId };
  }

  const services = () =>
    buildHostServices(db, "plugin-record-id", "paperclip.feedback-intake", createEventBusStub());

  it("stores the bytes, records the attachment and logs it as the plugin", async () => {
    const { companyId, issueId } = await seedIssue();
    const bytes = Buffer.from("PNGDATA");

    const attachment = await services().issues.createAttachment({
      issueId,
      companyId,
      filename: "../../etc/screenshot-1.png",
      contentType: "IMAGE/PNG; charset=binary",
      contentBase64: bytes.toString("base64"),
    });

    expect(attachment.issueId).toBe(issueId);
    expect(attachment.companyId).toBe(companyId);
    expect(attachment.contentType).toBe("image/png");
    expect(attachment.byteSize).toBe(bytes.length);
    expect(attachment.originalFilename).toBe("screenshot-1.png");
    expect(attachment.createdByAgentId).toBeNull();
    expect(attachment.createdByUserId).toBeNull();
    expect(attachment.contentPath).toBe(`/api/attachments/${attachment.id}/content`);
    expect(attachment).not.toHaveProperty("artifactWorkProductId");
    expect(attachment.objectKey.startsWith(`${companyId}/issues/${issueId}/`)).toBe(true);
    expect(stored.get(attachment.objectKey)?.toString()).toBe("PNGDATA");

    const listed = await services().issues.listAttachments({ issueId, companyId });
    expect(listed.map((row) => row.id)).toEqual([attachment.id]);
    const content = await services().issues.getAttachmentContent({ attachmentId: attachment.id, companyId });
    expect(Buffer.from(content!.contentBase64, "base64").toString()).toBe("PNGDATA");

    const log = await db.select().from(activityLog).where(eq(activityLog.action, "issue.attachment_added"));
    expect(log).toHaveLength(1);
    expect(log[0]!.actorType).toBe("plugin");
    expect(log[0]!.actorId).toBe("plugin-record-id");
    expect(log[0]!.entityId).toBe(issueId);
    expect(log[0]!.details).toMatchObject({
      attachmentId: attachment.id,
      originalFilename: "screenshot-1.png",
      contentType: "image/png",
      byteSize: bytes.length,
    });
  });

  it("strips Windows-style directories from the filename", async () => {
    const { companyId, issueId } = await seedIssue();

    const attachment = await services().issues.createAttachment({
      issueId,
      companyId,
      filename: "C:\\Users\\someone\\crash.log",
      contentType: "text/plain",
      contentBase64: Buffer.from("boom").toString("base64"),
    });

    expect(attachment.originalFilename).toBe("crash.log");
  });

  it("refuses an issue in another company and stores nothing", async () => {
    const { issueId } = await seedIssue();
    const other = await seedIssue();

    await expect(
      services().issues.createAttachment({
        issueId,
        companyId: other.companyId,
        filename: "a.png",
        contentType: "image/png",
        contentBase64: Buffer.from("x").toString("base64"),
      }),
    ).rejects.toThrow("Issue not found");
    expect(stored.size).toBe(0);
    expect(await db.select().from(issueAttachments)).toHaveLength(0);
  });

  it("refuses a private issue the plugin cannot read when privacy is enforced", async () => {
    const previousMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    try {
      const { companyId, issueId } = await seedIssue("private");
      await expect(
        services().issues.createAttachment({
          issueId,
          companyId,
          filename: "a.png",
          contentType: "image/png",
          contentBase64: Buffer.from("x").toString("base64"),
        }),
      ).rejects.toThrow("Issue not found");
      expect(stored.size).toBe(0);
    } finally {
      if (previousMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
      else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousMode;
    }
  });

  it("refuses an empty or over-limit attachment before storing it", async () => {
    const { companyId, issueId } = await seedIssue();
    const base = { issueId, companyId, filename: "a.bin", contentType: "application/octet-stream" };

    await expect(services().issues.createAttachment({ ...base, contentBase64: "" })).rejects.toThrow(
      "Attachment is empty",
    );
    await expect(
      services().issues.createAttachment({
        ...base,
        contentBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"),
      }),
    ).rejects.toThrow("larger than the");
    expect(stored.size).toBe(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("refuses content that is not valid base64 before storing it", async () => {
    const { companyId, issueId } = await seedIssue();

    await expect(
      services().issues.createAttachment({
        issueId,
        companyId,
        filename: "a.bin",
        contentType: "application/octet-stream",
        contentBase64: "not*base64!",
      }),
    ).rejects.toThrow("contentBase64 is not valid base64");
    await expect(
      services().issues.createAttachment({
        issueId,
        companyId,
        filename: "a.bin",
        contentType: "application/octet-stream",
        contentBase64: "YWJjZ",
      }),
    ).rejects.toThrow("contentBase64 is not valid base64");
    expect(stored.size).toBe(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });
});
