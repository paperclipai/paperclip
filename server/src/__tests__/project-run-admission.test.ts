import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, projects } from "@paperclipai/db";
import { assertProjectRunAdmissionOpen } from "../services/project-run-admission.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project run admission tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("project run admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string | null = null;
  let projectId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-run-admission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (!companyId) return;
    await db.delete(projects).where(eq(projects.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    companyId = null;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(status = "backlog") {
    companyId = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status });
  }

  it("rejects project-scoped admissions after deletion is marked", async () => {
    await seed("deleting");

    await expect(
      db.transaction((tx) =>
        assertProjectRunAdmissionOpen(tx as unknown as typeof db, companyId!, projectId),
      ),
    ).rejects.toMatchObject({ status: 409, details: { code: "project_deleting" } });
  });

  it("serializes deletion marking after an admission that already holds the project lock", async () => {
    await seed();
    let releaseAdmission!: () => void;
    let admissionLocked!: () => void;
    const admissionLockedPromise = new Promise<void>((resolve) => {
      admissionLocked = resolve;
    });
    const releaseAdmissionPromise = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });

    const admission = db.transaction(async (tx) => {
      await assertProjectRunAdmissionOpen(tx as unknown as typeof db, companyId, projectId);
      admissionLocked();
      await releaseAdmissionPromise;
    });
    await admissionLockedPromise;

    let markerCommitted = false;
    const marker = db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({ status: "deleting" })
        .where(eq(projects.id, projectId));
      markerCommitted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(markerCommitted).toBe(false);

    releaseAdmission();
    await Promise.all([admission, marker]);
    await expect(
      db.transaction((tx) =>
        assertProjectRunAdmissionOpen(tx as unknown as typeof db, companyId!, projectId),
      ),
    ).rejects.toMatchObject({ status: 409, details: { code: "project_deleting" } });
  });
});
