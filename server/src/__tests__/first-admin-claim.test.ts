import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, instanceUserRoles } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { claimFirstInstanceAdmin } from "../first-admin-claim.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("claimFirstInstanceAdmin", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-first-admin-claim-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(instanceUserRoles);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inserts exactly one first admin and reports later claims as conflicts", async () => {
    const firstUserId = `user-${randomUUID()}`;
    const first = await claimFirstInstanceAdmin(db, { userId: firstUserId });

    expect(first).toMatchObject({ status: "claimed", userId: firstUserId });

    const second = await claimFirstInstanceAdmin(db, { userId: `user-${randomUUID()}` });
    expect(second).toMatchObject({ status: "already_claimed", existingUserId: firstUserId });

    const roles = await db.select().from(instanceUserRoles);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ userId: firstUserId, role: "instance_admin" });
  });

  it("runs onClaim inside the winning transaction", async () => {
    const userId = `user-${randomUUID()}`;
    const result = await claimFirstInstanceAdmin(db, {
      userId,
      onClaim: async (tx) => {
        const roles = await tx.select().from(instanceUserRoles);
        return roles.map((role) => role.userId);
      },
    });

    expect(result).toMatchObject({ status: "claimed", userId, value: [userId] });
  });
});
