import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  principalGrantLock,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * Grant writes against a membership that is being taken away underneath them.
 *
 * Nothing in the schema ties `principal_permission_grants` to
 * `company_memberships`: no foreign key, and the revoke path deletes the grants
 * itself rather than relying on a cascade. So the two only stay consistent if
 * every grant writer decides against a membership state that is still true when
 * its rows land — and that is the property the round-3 work did not have.
 * `ensureMembership` ran on the pool, before the writer's transaction existed,
 * which made it a check whose answer could be stale by the time the write
 * committed. A removal landing in that window left an archived member holding a
 * full set of grants: inert while they were out, and authority again the moment
 * anyone re-added them.
 *
 * The existing races in `cross-issue-influence-limit-postgres.test.ts` all put
 * the writer first. These put the revoker first, and then stop choosing: the
 * interleaved case lets PostgreSQL pick the winner and asserts the invariant
 * that has to hold either way (FAI-10152 round 4).
 */
describeEmbeddedPostgres("principal grant writes against a vanishing membership", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const PERMISSION_KEY = "agents:create" as const;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-grant-membership-");
    db = createDb(tempDb.connectionString);
  }, 900_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Blocks until PostgreSQL reports the expected number of sessions genuinely
   * blocked, and fails if they never appear.
   *
   * A `setTimeout` would prove nothing: it elapses identically whether the
   * other sessions are blocked behind the lock this test holds or simply have
   * not been scheduled, so the interleaving test would stay green with the lock
   * removed. An ungranted row in `pg_locks` is the server stating that someone
   * is queued.
   *
   * Locktype is not filtered, because the two contenders do not always queue on
   * the same object. `updateMemberAndPermissions` takes the membership row
   * before the advisory key — it is the one grant writer that also writes that
   * row, so it has to keep the removal paths' ordering — which leaves the
   * removal waiting on the row while the writer waits on the key. Both are
   * still blocked; insisting they be blocked on the *same* lock would assert
   * the mechanism instead of the fact.
   */
  async function waitForLockWaiters(expected: number, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await db.execute(sql`
        SELECT count(DISTINCT pid)::int AS waiting
        FROM pg_locks
        WHERE NOT granted
          AND pid <> pg_backend_pid()
      `);
      const waiting = Number((Array.isArray(rows) ? rows[0] : null)?.waiting ?? 0);
      if (waiting >= expected) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `expected ${expected} blocked session(s) within ${timeoutMs}ms, saw ${waiting}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * A company with an owner (so removing anyone else is allowed) and one
   * `operator` member holding a single grant.
   */
  async function seedMemberWithGrant(options: { status?: "active" | "pending" } = {}) {
    const companyId = randomUUID();
    const userId = `member-${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      membershipRole: "owner",
      status: "active",
    });
    const membership = await db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType: "user",
        principalId: userId,
        membershipRole: "operator",
        status: options.status ?? "active",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey: PERMISSION_KEY,
      scope: null,
      expiresAt: null,
    });

    return { companyId, userId, membershipId: membership.id };
  }

  async function grantsFor(companyId: string, principalId: string) {
    return db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      );
  }

  async function membershipStatus(companyId: string, principalId: string) {
    return db
      .select({ status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0]?.status ?? null);
  }

  /**
   * Every writer of these rows, driven through the same shape. They reach the
   * same table by four different routes — a single-permission upsert, two
   * wholesale replacements from the members UI, and the principal-level
   * replacement the plugin host and the invite flows call — and each was
   * repaired on its own, which is how the fix kept looking complete while a
   * route was still open.
   */
  type Writer = (input: { companyId: string; userId: string; membershipId: string }) => Promise<unknown>;
  const writers: Array<[string, Writer]> = [
    ["single-permission upsert", ({ companyId, userId }) =>
      accessService(db).setPrincipalPermission(companyId, "user", userId, PERMISSION_KEY, true, null)],
    ["principal grant replacement", ({ companyId, userId }) =>
      accessService(db).setPrincipalGrants(
        companyId,
        "user",
        userId,
        [{ permissionKey: PERMISSION_KEY, scope: null }],
        null,
      )],
    ["member permission replacement", ({ companyId, membershipId }) =>
      accessService(db).setMemberPermissions(
        companyId,
        membershipId,
        [{ permissionKey: PERMISSION_KEY, scope: null }],
        null,
      )],
    ["member update carrying permissions", ({ companyId, membershipId }) =>
      accessService(db).updateMemberAndPermissions(
        companyId,
        membershipId,
        { grants: [{ permissionKey: PERMISSION_KEY, scope: null }] },
        null,
      )],
  ];

  it.each(writers)("refuses a %s for a principal removed first", async (_label, write) => {
    const seeded = await seedMemberWithGrant();
    const access = accessService(db);

    await access.archiveMember(seeded.companyId, seeded.membershipId);
    expect(await grantsFor(seeded.companyId, seeded.userId)).toHaveLength(0);

    // The stale writer, arriving after the removal committed. Before this it
    // reinserted the grants the removal had just deleted.
    await expect(write(seeded)).rejects.toThrow(/removed from company/);
    expect(await grantsFor(seeded.companyId, seeded.userId)).toHaveLength(0);
  });

  /**
   * The consequence the refusal exists to prevent. A dormant grant row is
   * harmless only for as long as the membership stays archived; re-adding the
   * principal is a routine act that would have silently restored every
   * permission they held when they left, without anyone granting them again.
   */
  it.each(writers)("does not hand authority back on re-add after a %s", async (_label, write) => {
    const seeded = await seedMemberWithGrant();
    const access = accessService(db);

    await access.archiveMember(seeded.companyId, seeded.membershipId);
    await expect(write(seeded)).rejects.toThrow();

    await access.ensureMembership(seeded.companyId, "user", seeded.userId, "operator", "active");

    expect(await membershipStatus(seeded.companyId, seeded.userId)).toBe("active");
    expect(await grantsFor(seeded.companyId, seeded.userId)).toHaveLength(0);
  });

  /**
   * Neither ordering is chosen here. Both sessions queue on the principal's
   * advisory lock while a third holds it, and PostgreSQL decides who goes
   * first — so the assertion has to be the invariant that survives either
   * answer: a removed principal ends with no grants.
   *
   * Writer first: the grants land, and the revoker's delete runs behind them.
   * Revoker first: the writer's membership read, taken after the lock, sees
   * `archived` and refuses. What must never happen is the third outcome the
   * pooled `ensureMembership` allowed — the writer deciding on a membership it
   * read before the removal and committing rows after it.
   */
  it.each(writers)("leaves a removed principal no grants whichever of the %s and the removal wins", async (
    _label,
    write,
  ) => {
    const seeded = await seedMemberWithGrant();
    const { companyId, userId, membershipId } = seeded;
    const access = accessService(db);

    let releaseHold!: () => void;
    const holdTaken = new Promise<void>((resolve) => { releaseHold = resolve; });
    let releaseWaiters!: () => void;
    const bothQueued = new Promise<void>((resolve) => { releaseWaiters = resolve; });

    // A third session holding the principal's grant lock, so the writer and the
    // revoker both have to queue and neither can be merely "slow".
    const holder = db.transaction(async (tx) => {
      await tx.execute(principalGrantLock({ companyId, principalType: "user", principalId: userId }));
      releaseHold();
      await bothQueued;
    });

    await holdTaken;
    const writerSettled = write(seeded).then(
      () => "committed" as const,
      () => "refused" as const,
    );
    const revoker = access.archiveMember(companyId, membershipId);

    // Both are provably blocked on the lock this test holds before it lets go.
    await waitForLockWaiters(2);
    releaseWaiters();

    const [outcome] = await Promise.all([writerSettled, revoker, holder]);

    expect(["committed", "refused"]).toContain(outcome);
    expect(await membershipStatus(companyId, userId)).toBe("archived");
    expect(await grantsFor(companyId, userId)).toHaveLength(0);
  });

  /**
   * The remedy has to work. Archiving is idempotent on the membership row, and
   * it used to return as soon as it saw `archived` — before taking the lock and
   * before the delete. So on the one state where grants can outlive a removal,
   * calling archive again was the obvious fix and did nothing at all.
   */
  it("clears grants that outlived a first archive when the member is archived again", async () => {
    const { companyId, userId, membershipId } = await seedMemberWithGrant();
    const access = accessService(db);

    await access.archiveMember(companyId, membershipId);
    // Whatever put them there — an older build, a writer that raced the first
    // archive — this is the state an operator has to be able to clean up.
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey: PERMISSION_KEY,
      scope: null,
      expiresAt: null,
    });

    const second = await access.archiveMember(companyId, membershipId);

    expect(second?.member.status).toBe("archived");
    expect(await grantsFor(companyId, userId)).toHaveLength(0);
  });

  /**
   * The seeder is a writer too, and the quietest one. `ON CONFLICT DO NOTHING`
   * is idempotent against rows that exist when it runs, which says nothing
   * about standing: queued behind a removal, it resumed afterwards and put the
   * role's whole default set back on someone who had just been removed.
   */
  it("puts no role defaults back on a principal removed first", async () => {
    const { companyId, userId, membershipId } = await seedMemberWithGrant();
    const access = accessService(db);

    await access.archiveMember(companyId, membershipId);

    const inserted = await access.ensureRoleDefaultGrants(companyId, userId, "operator", null);

    expect(inserted).toBe(0);
    expect(await grantsFor(companyId, userId)).toHaveLength(0);
  });

  /**
   * Absent is not removed. Every removal path leaves an `archived` row behind,
   * so a principal with no membership row at all has never been a member — that
   * is the state a freshly created agent and a company import are in, and the
   * grant writers still have to admit them. Refusing here would have turned the
   * resurrection fix into a broken clone.
   */
  it("still admits a principal that has no membership row", async () => {
    const { companyId } = await seedMemberWithGrant();
    const access = accessService(db);
    const agentId = randomUUID();

    await access.setPrincipalPermission(companyId, "agent", agentId, PERMISSION_KEY, true, null);

    expect(await membershipStatus(companyId, agentId)).toBe("active");
    expect(await grantsFor(companyId, agentId)).toHaveLength(1);
  });

  /**
   * Writing a permission is not a decision to admit anyone. The pooled
   * `ensureMembership(…, "member", "active")` in front of every grant write was
   * an activation: it flipped a stood-down principal back to `active` as a side
   * effect of an unrelated permission edit, and it did it outside the lock and
   * outside the transaction. Standing belongs to the membership endpoints.
   */
  it("leaves a pending membership pending", async () => {
    const { companyId, userId } = await seedMemberWithGrant({ status: "pending" });
    const access = accessService(db);

    await access.setPrincipalPermission(companyId, "user", userId, PERMISSION_KEY, true, null);

    expect(await membershipStatus(companyId, userId)).toBe("pending");
    // The grant is written and confers nothing: `decidePrincipalGrant` denies
    // every key behind a non-active membership. Inert, not absent.
    expect(await grantsFor(companyId, userId)).toHaveLength(1);
  });
});
