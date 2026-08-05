import { randomUUID } from "node:crypto";
import express, { type Router } from "express";
import { isNotNull } from "drizzle-orm";
import {
  companies,
  companyMemberships,
  createDb,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { ensureHumanRoleDefaultGrants } from "../../services/principal-access-compatibility.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";

type Db = ReturnType<typeof createDb>;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();

/** `describe` on hosts that can run embedded Postgres, `describe.skip` elsewhere. */
export const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

export type EmbeddedPostgresContext = { readonly db: Db };

/**
 * Registers the embedded Postgres lifecycle for the enclosing `describe`. Read
 * `.db` from inside a test; it is unavailable until `beforeAll` has run.
 */
export function useEmbeddedPostgres(
  prefix: string,
  opts: { resetEach?: (db: Db) => Promise<void> } = {},
): EmbeddedPostgresContext {
  let db: Db | null = null;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(prefix);
    db = createDb(tempDb.connectionString);
  }, 20_000);

  if (opts.resetEach) {
    const resetEach = opts.resetEach;
    afterEach(async () => {
      if (db) await resetEach(db);
    });
  }

  afterAll(async () => {
    await tempDb?.cleanup();
    tempDb = null;
    db = null;
  });

  return {
    get db() {
      if (!db) throw new Error("embedded Postgres is not started yet — read .db inside a test");
      return db;
    },
  };
}

export type BoardActor = {
  type: "board";
  source: string;
  userId: string;
  companyIds: string[];
  memberships: { companyId: string; membershipRole: string; status: string }[];
  isInstanceAdmin: boolean;
};

export type SeededCompany = { companyId: string; userId: string; actor: BoardActor };

/** Creates a company whose board user holds company-scoped read and write grants. */
export async function seedCompanyWithBoardAccess(db: Db, name: string): Promise<SeededCompany> {
  const companyId = randomUUID();
  const userId = `user-${randomUUID()}`;
  await db.insert(companies).values({
    id: companyId,
    name: `${name} ${companyId}`,
    issuePrefix: `T${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "owner",
    updatedAt: new Date(),
  });
  await ensureHumanRoleDefaultGrants(db, {
    companyId,
    principalId: userId,
    membershipRole: "owner",
    grantedByUserId: null,
  });
  return {
    companyId,
    userId,
    actor: {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    },
  };
}

type RouterFactory = (db: Db, storage: never) => Router;

/** Mounts route modules under `/api` behind a fixed actor, with the real error handler. */
export function routeApp(db: Db, actor: BoardActor, ...routerFactories: RouterFactory[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  for (const factory of routerFactories) {
    app.use("/api", factory(db, {} as never));
  }
  app.use(errorHandler);
  return app;
}

/**
 * Clears the company and issue fixtures seeded by `seedCompanyWithBoardAccess`.
 * Suites that seed other tables need their own reset.
 */
export async function resetCompanyIssueFixtures(db: Db) {
  await db.delete(issues).where(isNotNull(issues.parentId));
  await db.delete(issues);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}
