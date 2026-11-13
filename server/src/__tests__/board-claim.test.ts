import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
  subscribeDatabaseWork,
} from "@paperclipai/db";
import {
  claimBoardOwnership,
  getBoardClaimWarningUrl,
  initializeBoardClaimChallenge,
  inspectBoardClaimChallenge,
} from "../board-claim.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_BOARD_CLAIM_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("board claim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-claim-");
    db = createDb(external ?? tempDb!.connectionString);
  }, 20_000);

  afterEach(async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  it.each(["new", "suspended", "active"] as const)("claims a local-board-only instance with %s membership and wakes only restored authority", async prior => {
    const now = new Date();
    const userId = `claim-user-${randomUUID()}`;
    const company = await db
      .insert(companies)
      .values({
        name: "Board Claim Co",
        issuePrefix: `BC${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(authUsers).values({
      id: userId,
      name: "Board Claim User",
      email: "board-claim@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(instanceUserRoles).values({
      userId: "local-board",
      role: "instance_admin",
    });

    if (prior !== "new") await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId,
      status: prior, membershipRole: "owner",
    });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const warningUrl = getBoardClaimWarningUrl("127.0.0.1", 3197);
    expect(warningUrl).toBeTruthy();

    const parsed = new URL(warningUrl!);
    const token = parsed.pathname.split("/").pop()!;
    const code = parsed.searchParams.get("code")!;

    expect(inspectBoardClaimChallenge(token, code)).toMatchObject({
      status: "available",
      requiresSignIn: true,
      claimedByUserId: null,
    });

    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, event => events.push(event));
    try {
      await db.transaction(async tx => {
        await expect(claimBoardOwnership(tx as unknown as typeof db, { token, code, userId }))
          .resolves.toEqual({ status: "claimed", claimedByUserId: userId });
        expect(events).toEqual(prior === "active" ? [] : ["intent"]);
        // A nested claim must not publish a commit before its caller settles.
        const outside = await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, company.id));
        expect(outside.map(row => row.status)).toEqual(prior === "new" ? [] : [prior]);
      });
      expect(events).toEqual(prior === "active" ? [] : ["intent", "settled"]);
    } finally { unsubscribe(); }

    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, "local-board"), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        ),
    ).resolves.toMatchObject([
      {
        status: "active",
        membershipRole: "owner",
      },
    ]);
    expect(inspectBoardClaimChallenge(token, code)).toMatchObject({
      status: "claimed",
      claimedByUserId: userId,
    });
  });
});
