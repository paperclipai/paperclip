import type { Db } from "@paperclipai/db";
import type { BoardBootstrap } from "@paperclipai/shared";
import { boardAuthService } from "./board-auth.js";
import { companyService } from "./companies.js";

/** The actor has already authenticated and resolved current company authority. */
export async function loadBoardBootstrap(db: Db, principal: {
  userId: string;
  companyIds: readonly string[];
}): Promise<BoardBootstrap> {
  const [companies, access] = await Promise.all([
    companyService(db).list(),
    boardAuthService(db).resolveBoardAccess(principal.userId),
  ]);
  const accessible = new Set(principal.companyIds);
  return {
    userId: principal.userId,
    // Match /companies?scope=accessible: directory visibility through instance
    // admin alone does not grant entry to a company's inbox or tasks.
    companies: companies.filter((company) => accessible.has(company.id)),
    boardAccess: {
      userId: principal.userId,
      isInstanceAdmin: access.isInstanceAdmin,
      companyIds: access.companyIds,
    },
  };
}
