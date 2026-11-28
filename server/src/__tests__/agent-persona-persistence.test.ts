import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
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
    const serviceLifecycle = createAgentLifecycle(db);
    const random = await serviceLifecycle.requestHire(companyId, { name: "Random", role: "engineer", adapterType: "process" });
    expect(agentAppearanceSchema.safeParse(random.appearance).success).toBe(true);
    const appearance = appearanceForPalette("arctic-blue");
    const original = await serviceLifecycle.requestHire(companyId, { name: "Draft", role: "engineer", adapterType: "process", appearance });
    expect(original.appearance).toEqual(appearance);
    const updated = await service.update(original.id, { name: "Renamed" }, { recordRevision: { source: "test" } });
    expect(updated?.appearance).toEqual(appearance);
    const [revision] = await service.listConfigRevisions(original.id);
    await service.update(original.id, { name: "Changed again" });
    await serviceLifecycle.pauseAgent(original.id);
    const restored = await service.rollbackConfigRevision(original.id, revision.id, {});
    expect(restored?.appearance).toEqual(appearance);
    expect((await agentService(db).getById(original.id))?.avatarUrl).toContain("/arctic-blue/rest.png?size=512");
    const [row] = await db.select().from(agents).where(eq(agents.id, original.id));
    expect(row.appearance).toEqual(appearance);
  });
  it("restores the revision's icon and appearance on rollback and records them in the rollback revision", async () => {
    const service = agentService(db);
    const appearance = appearanceForPalette("arctic-blue");
    const newerAppearance = appearanceForPalette("cherry-pop");
    const original = await createAgentLifecycle(db).requestHire(companyId, { name: "Restored persona", role: "engineer", adapterType: "process", icon: "bot", appearance });
    await service.update(original.id, { title: "First" }, { recordRevision: { source: "test" } });
    const [revision] = await service.listConfigRevisions(original.id);
    await service.update(original.id, { title: "Second", icon: "brain", appearance: newerAppearance });
    const restored = await service.rollbackConfigRevision(original.id, revision.id, {});
    expect(restored).toMatchObject({ title: "First", icon: "bot", appearance });
    const [row] = await db.select().from(agents).where(eq(agents.id, original.id));
    expect(row).toMatchObject({ icon: "bot", appearance });
    const [rollbackRevision] = await service.listConfigRevisions(original.id);
    expect(rollbackRevision.source).toBe("rollback");
    expect(rollbackRevision.changedKeys).toEqual(expect.arrayContaining(["icon", "appearance"]));
    expect(rollbackRevision.afterConfig).toMatchObject({ title: "First", icon: "bot", appearance });
  });
  it("clears the icon when the rolled back revision recorded no icon", async () => {
    const service = agentService(db);
    const original = await createAgentLifecycle(db).requestHire(companyId, { name: "Iconless persona", role: "engineer", adapterType: "process", icon: null });
    await service.update(original.id, { title: "First" }, { recordRevision: { source: "test" } });
    const [revision] = await service.listConfigRevisions(original.id);
    await service.update(original.id, { icon: "brain" });
    const restored = await service.rollbackConfigRevision(original.id, revision.id, {});
    expect(restored?.icon).toBeNull();
  });
  it.each([
    ["missing", (config: Record<string, unknown>) => {
      const { icon: _icon, appearance: _appearance, ...rest } = config;
      return rest;
    }],
    ["invalid", (config: Record<string, unknown>) => ({ ...config, icon: 42, appearance: { paletteId: "not-a-palette" } })],
  ])("keeps the current icon and appearance when the revision's values are %s", async (kind, rewrite) => {
    const service = agentService(db);
    const newerAppearance = appearanceForPalette("cherry-pop");
    const original = await createAgentLifecycle(db).requestHire(companyId, { name: `Older revision ${kind}`, role: "engineer", adapterType: "process", icon: "bot", appearance: appearanceForPalette("arctic-blue") });
    await service.update(original.id, { title: "First" }, { recordRevision: { source: "test" } });
    const [revision] = await service.listConfigRevisions(original.id);
    await db.update(agentConfigRevisions).set({ afterConfig: rewrite(revision.afterConfig) }).where(eq(agentConfigRevisions.id, revision.id));
    await service.update(original.id, { title: "Second", icon: "brain", appearance: newerAppearance });
    const restored = await service.rollbackConfigRevision(original.id, revision.id, {});
    expect(restored).toMatchObject({ title: "First", icon: "brain", appearance: newerAppearance });
  });
  it("backfills legacy IDs with exactly the same persisted identity as the runtime fallback", async () => {
    const ids = Array.from({ length: 20 }, () => randomUUID());
    await db.insert(agents).values(ids.map((id, i) => ({ id, companyId, name: `Legacy ${i}`, role: "engineer", appearance: null, icon: "bot" })));
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0280_unique_genesis.sql", import.meta.url), "utf8");
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
