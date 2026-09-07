import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  documentRevisions,
  documents,
  issueDocuments,
  issues,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { eq } from "drizzle-orm";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
        clear: () => {},
      };
    },
  } as any;
}

describeEmbeddedPostgres("plugin issue document CAS bridge", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-document-cas-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("forwards CAS to the core service and preserves conflicts without mutation", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "CAS Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "CAS-1",
      title: "CAS issue",
      status: "todo",
      priority: "medium",
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.test", createEventBusStub());
    try {
      const created = await services.issueDocuments.upsert({
        companyId,
        issueId,
        key: "plan",
        body: "v1",
        baseRevisionId: null,
      });
      expect(created.latestRevisionNumber).toBe(1);

      const revisionCount = async () => db
        .select({ revisionNumber: documentRevisions.revisionNumber })
        .from(documentRevisions)
        .where(eq(documentRevisions.documentId, created.id));

      await expect(services.issueDocuments.upsert({
        companyId,
        issueId,
        key: "plan",
        body: "blind",
      })).rejects.toMatchObject({
        status: 409,
        message: "Document update requires baseRevisionId",
      });
      await expect(revisionCount()).resolves.toHaveLength(1);

      await expect(services.issueDocuments.upsert({
        companyId,
        issueId,
        key: "plan",
        body: "stale",
        baseRevisionId: "stale-revision",
      })).rejects.toMatchObject({
        status: 409,
        message: "Document was updated by someone else",
      });
      await expect(revisionCount()).resolves.toHaveLength(1);

      const updated = await services.issueDocuments.upsert({
        companyId,
        issueId,
        key: "plan",
        body: "v2",
        baseRevisionId: created.latestRevisionId,
      });
      expect(updated.latestRevisionNumber).toBe(2);
      expect(updated.body).toBe("v2");

      await expect(services.issueDocuments.upsert({
        companyId,
        issueId,
        key: "missing",
        body: "must not create",
        baseRevisionId: updated.latestRevisionId,
      })).rejects.toMatchObject({
        status: 409,
        message: "Document does not exist yet",
      });
      await expect(db.select().from(issueDocuments).where(eq(issueDocuments.issueId, issueId)))
        .resolves.toHaveLength(1);
    } finally {
      services.dispose();
    }
  });

  it("keeps company isolation at the plugin bridge", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyA,
        name: "Company A",
        issuePrefix: `A${companyA.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: companyB,
        name: "Company B",
        issuePrefix: `B${companyB.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId: companyA,
      identifier: "A-1",
      title: "Company A issue",
      status: "todo",
      priority: "medium",
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.test", createEventBusStub());
    try {
      await expect(services.issueDocuments.upsert({
        companyId: companyB,
        issueId,
        key: "plan",
        body: "must be denied",
        baseRevisionId: null,
      })).rejects.toThrow("Issue not found");
      await expect(db.select().from(issueDocuments)).resolves.toHaveLength(0);
    } finally {
      services.dispose();
    }
  });
});
