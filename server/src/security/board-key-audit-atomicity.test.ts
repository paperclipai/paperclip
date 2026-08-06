import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boardApiKeyAuthorizationEvents,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type Db,
  type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import {
  BOARD_KEY_AUDIT_COUPLINGS,
  createBoardKeyAuditContext,
  instrumentDbForBoardKeyAudit,
  runWithBoardKeyAuditContext,
  settleBoardKeyAuditContext,
  stageBoardKeyAllowAudit,
  type BoardKeyAuditValues,
} from "./board-key-audit-coupling.js";
import { boardKeyAuthorizationMiddleware } from "./board-key-route-registry.js";

/**
 * Stand-in for any board-key-protected domain table. Using a dedicated table
 * keeps the regression focused on the audit/mutation boundary itself instead of
 * the constraints of whichever real table a route happens to write.
 */
const probe = pgTable("board_key_atomicity_probe", {
  id: uuid("id").primaryKey().defaultRandom(),
  value: text("value").notNull(),
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("board-key allow audit / mutation atomicity", () => {
  let database: EmbeddedPostgresTestDatabase;
  let db: Db;
  // Independent connection pool: reads through it can only observe committed
  // rows, which is how the test proves the audit row lives inside the domain
  // transaction rather than in a separate one.
  let outside: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-board-key-atomicity-");
    db = instrumentDbForBoardKeyAudit(createDb(database.connectionString));
    outside = createDb(database.connectionString);
    await outside.execute(sql`
      CREATE TABLE IF NOT EXISTS board_key_atomicity_probe (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        value text NOT NULL
      )
    `);
  }, 240_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  function stagedAllow(overrides: Partial<BoardKeyAuditValues> = {}): BoardKeyAuditValues {
    return {
      boardApiKeyId: randomUUID(),
      ownerUserId: randomUUID(),
      tokenPrefix: "pcp_board_atomic",
      action: "issues:write",
      classification: "company",
      authoritativeCompanyId: null,
      authoritativeResourceType: "company",
      authoritativeResourceId: null,
      decision: "allow",
      reason: "authorized",
      requestId: randomUUID(),
      runId: null,
      details: {},
      ...overrides,
    };
  }

  async function committedAudit(boardApiKeyId: string) {
    return await outside
      .select({
        decision: boardApiKeyAuthorizationEvents.decision,
        reason: boardApiKeyAuthorizationEvents.reason,
        details: boardApiKeyAuthorizationEvents.details,
      })
      .from(boardApiKeyAuthorizationEvents)
      .where(eq(boardApiKeyAuthorizationEvents.boardApiKeyId, boardApiKeyId));
  }

  async function committedProbe(value: string) {
    return await outside.select({ value: probe.value }).from(probe).where(eq(probe.value, value));
  }

  it("commits the allow disposition inside the transaction of the mutation it authorizes", async () => {
    const values = stagedAllow();
    const marker = `commit-${randomUUID()}`;
    const context = createBoardKeyAuditContext();

    await runWithBoardKeyAuditContext(context, async () => {
      stageBoardKeyAllowAudit(values);
      // Staging alone must never be durable: that is the non-atomic behaviour
      // this coupling replaces.
      expect(await committedAudit(values.boardApiKeyId)).toHaveLength(0);
      await db.transaction(async (tx) => {
        await tx.insert(probe).values({ value: marker });
        // Still inside the transaction: neither the mutation nor its
        // disposition is visible to another connection yet.
        expect(await committedProbe(marker)).toHaveLength(0);
        expect(await committedAudit(values.boardApiKeyId)).toHaveLength(0);
      });
    });

    expect(context.flushed).toBe(true);
    expect(await committedProbe(marker)).toHaveLength(1);
    expect(await committedAudit(values.boardApiKeyId)).toEqual([
      {
        decision: "allow",
        reason: "authorized",
        details: { coupling: BOARD_KEY_AUDIT_COUPLINGS.transaction },
      },
    ]);
  }, 60_000);

  it("rolls the authorized mutation back when the audit write fails at the boundary", async () => {
    // Forced failure exactly at the audit/mutation boundary: `action` is NOT
    // NULL, so the coupled audit insert aborts the domain transaction.
    const values = stagedAllow({ action: null as unknown as string });
    const marker = `audit-failure-${randomUUID()}`;
    const context = createBoardKeyAuditContext();

    await expect(runWithBoardKeyAuditContext(context, async () => {
      stageBoardKeyAllowAudit(values);
      await db.transaction(async (tx) => {
        await tx.insert(probe).values({ value: marker });
      });
    })).rejects.toThrow();

    expect(context.flushed).toBe(false);
    expect(await committedProbe(marker)).toHaveLength(0);
    expect(await committedAudit(values.boardApiKeyId)).toHaveLength(0);

    // Settlement must not paper over the failure with a durable allow either.
    await settleBoardKeyAuditContext(db, context, 500);
    expect(await committedAudit(values.boardApiKeyId)).toHaveLength(0);
  }, 60_000);

  it("keeps no durable allow disposition when the protected mutation rolls back", async () => {
    const values = stagedAllow();
    const marker = `rollback-${randomUUID()}`;
    const context = createBoardKeyAuditContext();

    await expect(runWithBoardKeyAuditContext(context, async () => {
      stageBoardKeyAllowAudit(values);
      await db.transaction(async (tx) => {
        await tx.insert(probe).values({ value: marker });
        throw new Error("controller failed after mutating");
      });
    })).rejects.toThrow("controller failed after mutating");

    expect(context.flushed).toBe(false);
    expect(await committedProbe(marker)).toHaveLength(0);
    expect(await committedAudit(values.boardApiKeyId)).toHaveLength(0);
  }, 60_000);

  it("does not resurrect an allow disposition when a rolled-back mutation is swallowed", async () => {
    const values = stagedAllow();
    const marker = `swallowed-${randomUUID()}`;
    const context = createBoardKeyAuditContext();

    await runWithBoardKeyAuditContext(context, async () => {
      stageBoardKeyAllowAudit(values);
      await expect(db.transaction(async (tx) => {
        await tx.insert(probe).values({ value: marker });
        throw new Error("swallowed");
      })).rejects.toThrow("swallowed");
    });

    // The handler reports success, but nothing committed, so there is no
    // mutation for an `authorized` record to describe.
    await settleBoardKeyAuditContext(db, context, 200);
    expect(await committedProbe(marker)).toHaveLength(0);
    expect(await committedAudit(values.boardApiKeyId)).toHaveLength(0);
  }, 60_000);

  it("records the disposition of an authorized request that mutates nothing", async () => {
    const values = stagedAllow();
    const context = createBoardKeyAuditContext();

    await runWithBoardKeyAuditContext(context, async () => {
      stageBoardKeyAllowAudit(values);
      await db.select({ value: probe.value }).from(probe).limit(1);
    });
    await settleBoardKeyAuditContext(db, context, 204);

    expect(await committedAudit(values.boardApiKeyId)).toEqual([
      {
        decision: "allow",
        reason: "authorized",
        details: { coupling: BOARD_KEY_AUDIT_COUPLINGS.noMutation },
      },
    ]);
  }, 60_000);

  it("does not treat a read-only raw statement as an uncoupled mutation", async () => {
    const values = stagedAllow();
    const context = createBoardKeyAuditContext();

    await runWithBoardKeyAuditContext(context, async () => {
      stageBoardKeyAllowAudit(values);
      await db.execute(sql`SELECT 1`);
    });
    await settleBoardKeyAuditContext(db, context, 200);

    expect(context.untransacted).toBe(false);
    expect(await committedAudit(values.boardApiKeyId)).toEqual([
      {
        decision: "allow",
        reason: "authorized",
        details: { coupling: BOARD_KEY_AUDIT_COUPLINGS.noMutation },
      },
    ]);
  }, 60_000);

  it("couples a raw mutating statement issued inside a transaction", async () => {
    const values = stagedAllow();
    const marker = `raw-${randomUUID()}`;
    const context = createBoardKeyAuditContext();

    await runWithBoardKeyAuditContext(context, async () => {
      stageBoardKeyAllowAudit(values);
      await db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO board_key_atomicity_probe (value) VALUES (${marker})`);
      });
    });

    expect(context.flushed).toBe(true);
    expect(await committedProbe(marker)).toHaveLength(1);
    expect(await committedAudit(values.boardApiKeyId)).toEqual([
      {
        decision: "allow",
        reason: "authorized",
        details: { coupling: BOARD_KEY_AUDIT_COUPLINGS.transaction },
      },
    ]);
  }, 60_000);

  it("marks a mutation that ran outside any transaction as uncoupled", async () => {
    const values = stagedAllow();
    const marker = `untransacted-${randomUUID()}`;
    const context = createBoardKeyAuditContext();

    await runWithBoardKeyAuditContext(context, async () => {
      stageBoardKeyAllowAudit(values);
      await db.insert(probe).values({ value: marker });
    });
    await settleBoardKeyAuditContext(db, context, 201);

    expect(context.untransacted).toBe(true);
    expect(await committedProbe(marker)).toHaveLength(1);
    expect(await committedAudit(values.boardApiKeyId)).toEqual([
      {
        decision: "allow",
        reason: "authorized",
        details: { coupling: BOARD_KEY_AUDIT_COUPLINGS.untransacted },
      },
    ]);
  }, 60_000);

  describe("through the live request pipeline", () => {
    const ownerId = randomUUID();

    function createApp(keyId: string, handler: express.RequestHandler) {
      const app = express();
      app.use((req, _res, next) => {
        (req as unknown as { id: string }).id = randomUUID();
        (req as unknown as { actor: Record<string, unknown> }).actor = {
          type: "board",
          source: "board_key",
          userId: ownerId,
          keyId,
          boardKeyOwnerId: ownerId,
          boardKeyPrefix: "pcp_board_atomic",
          boardKeyScope: null,
          boardKeyLegacyUnrestricted: true,
          isInstanceAdmin: true,
          companyIds: [],
          memberships: [],
        };
        next();
      });
      app.use(boardKeyAuthorizationMiddleware(db));
      app.post("/api/companies", handler);
      app.use(errorHandler);
      return app;
    }

    it("couples the gate decision to a controller transaction across the middleware chain", async () => {
      const marker = `pipeline-commit-${randomUUID()}`;
      const keyId = randomUUID();
      const app = createApp(keyId, async (_req, res) => {
        await db.transaction(async (tx) => {
          await tx.insert(probe).values({ value: marker });
        });
        res.status(201).json({ ok: true });
      });

      const response = await request(app).post("/api/companies").send({});
      expect(response.status).toBe(201);
      expect(await committedProbe(marker)).toHaveLength(1);
      expect(await committedAudit(keyId)).toEqual([
        {
          decision: "allow",
          reason: "authorized",
          details: { coupling: BOARD_KEY_AUDIT_COUPLINGS.transaction },
        },
      ]);
    }, 60_000);

    it("leaves no allow disposition when the controller transaction fails", async () => {
      const marker = `pipeline-rollback-${randomUUID()}`;
      const keyId = randomUUID();
      const app = createApp(keyId, async (_req, _res) => {
        await db.transaction(async (tx) => {
          await tx.insert(probe).values({ value: marker });
          throw new Error("controller failed");
        });
      });

      const response = await request(app).post("/api/companies").send({});
      expect(response.status).toBe(500);
      // Give the response-completion settlement a chance to run.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await committedProbe(marker)).toHaveLength(0);
      expect(await committedAudit(keyId)).toHaveLength(0);
    }, 60_000);

    it("refuses to commit the mutation when the coupled audit write fails", async () => {
      const marker = `pipeline-audit-failure-${randomUUID()}`;
      // `board_api_key_id` is a uuid column, so this key identity makes the
      // coupled audit insert fail inside the controller's own transaction.
      const app = createApp("not-a-uuid", async (_req, res) => {
        await db.transaction(async (tx) => {
          await tx.insert(probe).values({ value: marker });
        });
        res.status(201).json({ ok: true });
      });

      const response = await request(app).post("/api/companies").send({});
      expect(response.status).toBe(500);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await committedProbe(marker)).toHaveLength(0);
    }, 60_000);
  });
});
