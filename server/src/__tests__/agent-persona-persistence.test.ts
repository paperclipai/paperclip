import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb } from "@paperclipai/db";
import { agentAppearanceSchema, appearanceForPalette, legacyAgentAppearance } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

describe("persisted agent personas", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-persona-persistence-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Persona test", issuePrefix: "CAP" });
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });
  it("randomizes once, accepts a saved draft and preserves identity across edits and revision rollback", async () => {
    const service = agentService(db);
    const random = await service.create(companyId, { name: "Random", role: "engineer", adapterType: "process" });
    expect(agentAppearanceSchema.safeParse(random.appearance).success).toBe(true);
    const appearance = appearanceForPalette("arctic-blue");
    const original = await service.create(companyId, { name: "Draft", role: "engineer", adapterType: "process", appearance });
    expect(original.appearance).toEqual(appearance);
    const updated = await service.update(original.id, { name: "Renamed" }, { recordRevision: { source: "test" } });
    expect(updated?.appearance).toEqual(appearance);
    const [revision] = await service.listConfigRevisions(original.id);
    await service.update(original.id, { name: "Changed again", status: "paused" });
    const restored = await service.rollbackConfigRevision(original.id, revision.id, {});
    expect(restored?.appearance).toEqual(appearance);
    expect((await agentService(db).getById(original.id))?.avatarUrl).toContain("/arctic-blue/rest.png?size=512");
    const [row] = await db.select().from(agents).where(eq(agents.id, original.id));
    expect(row.appearance).toEqual(appearance);
  });
  it("backfills legacy IDs with exactly the same persisted identity as the runtime fallback", async () => {
    const ids = Array.from({ length: 20 }, () => randomUUID());
    await db.insert(agents).values(ids.map((id, i) => ({ id, companyId, name: `Legacy ${i}`, role: "engineer", appearance: null, icon: "bot" })));
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0272_marvelous_madame_web.sql", import.meta.url), "utf8");
    // Replaying the entire migration must preserve saved choices and tolerate
    // an already-created column from an earlier worktree migration number.
    for (let replay = 0; replay < 2; replay++) {
      for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    }
    for (const id of ids) {
      const [row] = await db.select().from(agents).where(eq(agents.id, id));
      expect(row.appearance).toEqual(legacyAgentAppearance(id));
      expect(row.icon).toBe("bot");
    }
  });
});
