import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { goalService } from "../services/goals.js";

// Pins the goals.metadata contract plugins rely on through the SDK's
// goals.update path: the goal service persists `metadata` and `getById`
// returns it, and an update without `metadata` never wipes the stored value.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping goal metadata contract tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("goals.metadata write/read contract (SDK goals.update path)", () => {
  let stop: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-goal-metadata-");
    stop = started.stop;
    db = createDb(started.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Goal Metadata Co" });
  });

  afterAll(async () => {
    await stop?.();
  });

  it("update({ metadata }) persists and getById returns it (round-trip)", async () => {
    const service = goalService(db);
    const created = await service.create(companyId, {
      title: "goal with metadata",
      level: "task",
    });
    expect(created).toBeTruthy();

    const metadata = {
      progress: { total: 3, done: 1 },
      achieved_proposal: null,
      completion_criterion: "3 issues done",
    };
    const updated = await service.update(created!.id, { metadata });
    expect(updated?.metadata).toEqual(metadata);

    const fetched = await service.getById(created!.id);
    expect(fetched?.metadata).toEqual(metadata);
  });

  it("update without metadata leaves existing metadata intact (no accidental wipe)", async () => {
    const service = goalService(db);
    const created = await service.create(companyId, {
      title: "goal with stable metadata",
      level: "task",
    });
    await service.update(created!.id, { metadata: { keep: true } });

    const renamed = await service.update(created!.id, { title: "renamed" });
    expect(renamed?.metadata).toEqual({ keep: true });
  });
});
