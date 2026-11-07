import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { accessService } from "../services/access.js";

describe("agent membership discovery query scope", () => {
  it("joins the real same-company agent and scopes both membership and grant reads", async () => {
    const companyId = "company-one", agentId = "agent-one";
    const member = { id: "membership-one", companyId, principalType: "agent", principalId: agentId };
    let join: any, memberWhere: any, grantWhere: any;
    const memberships = { innerJoin: (_table: unknown, condition: unknown) => { join = condition; return memberships; },
      where: (condition: unknown) => { memberWhere = condition; return memberships; }, orderBy: async () => [{ member }] };
    const grants = { where: async (condition: unknown) => { grantWhere = condition; return [{ principalId: agentId, permissionKey: "agents:configure" }]; } };
    const db = { select: vi.fn().mockReturnValueOnce({ from: () => memberships }).mockReturnValueOnce({ from: () => grants }) };
    const result = await accessService(db as unknown as Db).listAgentMembers(companyId);
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(join).sql).toContain('"agents"."id"::text = "company_memberships"."principal_id"');
    expect(dialect.sqlToQuery(join).params).toEqual([companyId]);
    expect(dialect.sqlToQuery(memberWhere).params).toEqual([companyId, "agent"]);
    expect(dialect.sqlToQuery(grantWhere).params).toEqual([companyId, "agent", agentId]);
    expect(result).toEqual([{ ...member, grants: [{ principalId: agentId, permissionKey: "agents:configure" }] }]);
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
