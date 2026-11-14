import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

describe("agentService.listConfigRevisions limit", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-config-revisions-limit-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Revisions limit test", issuePrefix: "REV" });
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("returns all revisions newest first without a limit and bounds results with limit", async () => {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Revision Agent",
      role: "engineer",
      adapterType: "process",
    });

    const outOfOrderMinutes = [3, 7, 1, 6, 0, 5, 2, 4];
    const rows = outOfOrderMinutes.map((minute) => ({
      id: randomUUID(),
      companyId,
      agentId,
      beforeConfig: { step: minute },
      afterConfig: { step: minute + 1 },
      createdAt: new Date(Date.UTC(2026, 10, 14, 12, minute, 0)),
    }));
    await db.insert(agentConfigRevisions).values(rows);

    const svc = agentService(db);
    const allRevisions = await svc.listConfigRevisions(agentId);
    expect(allRevisions.map((r) => (r.beforeConfig as { step: number }).step)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);

    const limitedRevisions = await svc.listConfigRevisions(agentId, { limit: 5 });
    expect(limitedRevisions.map((r) => (r.beforeConfig as { step: number }).step)).toEqual([7, 6, 5, 4, 3]);
  });
});
