import { randomUUID } from "node:crypto";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, goals } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { getDefaultCompanyGoal } from "../services/goals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("getDefaultCompanyGoal", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-default-company-goal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `co-${companyId}` });
    return companyId;
  }

  async function addGoal(values: {
    title: string;
    level?: string;
    status?: string;
    parentId?: string | null;
    createdAt?: Date;
  }) {
    const id = randomUUID();
    await db.insert(goals).values({
      id,
      companyId,
      title: values.title,
      level: values.level ?? "company",
      status: values.status ?? "active",
      parentId: values.parentId ?? null,
      ...(values.createdAt ? { createdAt: values.createdAt } : {}),
    });
    return id;
  }

  it("prefers the oldest active company-level root goal", async () => {
    await seedCompany();
    const older = await addGoal({ title: "older", createdAt: new Date("2026-01-01") });
    await addGoal({ title: "newer", createdAt: new Date("2026-02-01") });

    expect((await getDefaultCompanyGoal(db, companyId))?.id).toBe(older);
  });

  // TES-2147: the only company-level goal was the achieved legacy MVP goal, so the
  // status-blind fallback tier handed it to every issue created without a goalId.
  it("returns null rather than an achieved goal", async () => {
    await seedCompany();
    await addGoal({ title: "Launch MVP", status: "achieved" });

    expect(await getDefaultCompanyGoal(db, companyId)).toBeNull();
  });

  it("returns null rather than a cancelled goal", async () => {
    await seedCompany();
    await addGoal({ title: "Abandoned", status: "cancelled" });

    expect(await getDefaultCompanyGoal(db, companyId)).toBeNull();
  });

  it("skips terminal goals to reach an open one", async () => {
    await seedCompany();
    await addGoal({ title: "Launch MVP", status: "achieved", createdAt: new Date("2026-01-01") });
    const planned = await addGoal({
      title: "Next",
      status: "planned",
      createdAt: new Date("2026-02-01"),
    });

    expect((await getDefaultCompanyGoal(db, companyId))?.id).toBe(planned);
  });

  // Goal rows default to level "task", so a company can hold active top-level goals
  // that this selector deliberately ignores. Null keeps them reportable as unattached.
  it("returns null when every active goal is below company level", async () => {
    await seedCompany();
    await addGoal({ title: "Launch MVP", status: "achieved" });
    await addGoal({ title: "G1", level: "task", status: "active" });

    expect(await getDefaultCompanyGoal(db, companyId)).toBeNull();
  });

  it("returns null for a company with no goals", async () => {
    await seedCompany();

    expect(await getDefaultCompanyGoal(db, companyId)).toBeNull();
  });
});
