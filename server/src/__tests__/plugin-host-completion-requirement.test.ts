import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as any;
}

describeEmbeddedPostgres("plugin host completion requirement guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-completion-requirement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedGatedIssue() {
    const company = await db
      .insert(companies)
      .values({ name: `Plugin ${randomUUID()}`, issuePrefix: `PCR${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Gated",
        status: "in_progress",
        completionRequirement: "workspace_delivery",
        completionRequirementRevision: 1,
      })
      .returning()
      .then((rows) => rows[0]!);
    return { company, issue };
  }

  it("rejects a plugin-supplied completion requirement on issue create", async () => {
    const { company } = await seedGatedIssue();
    const services = buildHostServices(db, "plugin-record-id", "completion-requirement", createEventBusStub());
    try {
      for (const fields of [
        { completionRequirement: "workspace_delivery" },
        { completionRequirement: null },
        { completionRequirementRevision: 7 },
      ]) {
        await expect(
          services.issues.create({ companyId: company.id, title: "Plugin issue", ...fields } as any),
        ).rejects.toMatchObject({ status: 403, details: { code: "completion_requirement_protected" } });
      }
    } finally {
      services.dispose();
    }
  });

  it("rejects a plugin clearing or changing the completion requirement, with or without actor ids", async () => {
    const { company, issue } = await seedGatedIssue();
    const services = buildHostServices(db, "plugin-record-id", "completion-requirement", createEventBusStub());
    try {
      for (const patch of [
        { completionRequirement: null },
        { completionRequirement: null, actorUserId: randomUUID() },
        { completionRequirement: "workspace_delivery", actorUserId: randomUUID() },
        { completionRequirementRevision: 99 },
        { completionRequirementRevision: 0, actorUserId: randomUUID() },
      ]) {
        await expect(
          services.issues.update({ companyId: company.id, issueId: issue.id, patch } as any),
        ).rejects.toMatchObject({ status: 403, details: { code: "completion_requirement_protected" } });
      }
      const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(stored?.completionRequirement).toBe("workspace_delivery");
      expect(stored?.completionRequirementRevision).toBe(1);
    } finally {
      services.dispose();
    }
  });

  it("still lets a plugin update an unrelated field on a gated issue", async () => {
    const { company, issue } = await seedGatedIssue();
    const services = buildHostServices(db, "plugin-record-id", "completion-requirement", createEventBusStub());
    try {
      const updated = await services.issues.update({
        companyId: company.id,
        issueId: issue.id,
        patch: { title: "Renamed" },
      } as any);
      expect(updated.title).toBe("Renamed");
      expect(updated.completionRequirement).toBe("workspace_delivery");
    } finally {
      services.dispose();
    }
  });
});
