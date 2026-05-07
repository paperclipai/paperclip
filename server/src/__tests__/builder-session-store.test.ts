import { randomUUID } from "node:crypto";
import {
  builderSessions,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { builderSessionStore } from "../services/builder/session-store.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres builder session store tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("builderSessionStore", () => {
  let db!: ReturnType<typeof createDb>;
  let store!: ReturnType<typeof builderSessionStore>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-builder-session-store-");
    db = createDb(tempDb.connectionString);
    store = builderSessionStore(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(builderSessions);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Bizbox",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("excludes archived sessions by default and includes them on demand", async () => {
    const companyId = await seedCompany();

    await db.insert(builderSessions).values([
      {
        id: randomUUID(),
        companyId,
        createdByUserId: "user-1",
        title: "Active session",
        adapterType: "claude_local",
        model: "test-model",
        archivedAt: null,
      },
      {
        id: randomUUID(),
        companyId,
        createdByUserId: "user-1",
        title: "Archived session",
        adapterType: "claude_local",
        model: "test-model",
        archivedAt: new Date("2026-05-06T12:00:00.000Z"),
      },
    ]);

    const visible = await store.listSessions(companyId);
    const all = await store.listSessions(companyId, { includeArchived: true });

    expect(visible).toHaveLength(1);
    expect(visible[0]?.title).toBe("Active session");
    expect(all).toHaveLength(2);
  });

  it("archives and restores a session with timestamp updates", async () => {
    const companyId = await seedCompany();
    const session = await store.createSession({
      companyId,
      createdByUserId: "user-1",
      title: "Archive me",
      adapterType: "claude_local",
      model: "test-model",
    });

    const archivedAt = new Date("2026-05-06T12:30:00.000Z");
    await store.archiveSession(session.id, archivedAt);
    const archived = await store.getSession(companyId, session.id);

    expect(archived?.archivedAt?.toISOString()).toBe(archivedAt.toISOString());
    expect(archived?.updatedAt.toISOString()).toBe(archivedAt.toISOString());

    const restoredAt = new Date("2026-05-06T12:45:00.000Z");
    await store.restoreSession(session.id, restoredAt);
    const restored = await store.getSession(companyId, session.id);

    expect(restored?.archivedAt).toBeNull();
    expect(restored?.updatedAt.toISOString()).toBe(restoredAt.toISOString());
  });
});
