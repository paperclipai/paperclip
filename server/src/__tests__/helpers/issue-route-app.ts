import { randomUUID } from "node:crypto";
import express from "express";
import { isNotNull } from "drizzle-orm";
import {
  companies,
  companyMemberships,
  createDb,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../../services/principal-access-compatibility.js";

type Db = ReturnType<typeof createDb>;

export type IssueRouteCompany = { companyId: string; userId: string };

/** Creates a company whose board user holds company-scoped read and write grants. */
export async function seedIssueRouteCompany(db: Db, name: string): Promise<IssueRouteCompany> {
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
  return { companyId, userId };
}

/** Mounts the real issue routes behind a board actor for one seeded company. */
export function issueRouteApp(db: Db, { companyId, userId }: IssueRouteCompany) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(db, {} as never));
  app.use(errorHandler);
  return app;
}

/** Clears issue-route fixtures, children first so the parent self-reference stays satisfied. */
export async function resetIssueRouteData(db: Db) {
  await db.delete(issues).where(isNotNull(issues.parentId));
  await db.delete(issues);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}
