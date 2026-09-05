import { describe, expect, it } from "bun:test";
import type { Db } from "@paperclipai/db";
import { createBoardKeyActorResolverFromService } from "./board-key-resolver-factory.js";

describe("board key resolver factory", () => {
  it("maps the board auth service methods into the HTTP resolver contract", async () => {
    const actor = await createBoardKeyActorResolverFromService({} as Db, {
      findBoardApiKeyByToken: async (token) =>
        token === "valid" ? { id: "key-1", userId: "user-1" } : null,
      resolveBoardAccess: async () => ({
        user: { name: "Board", email: "board@example.com" },
        companyIds: ["company-a"],
        memberships: [
          { companyId: "company-a", membershipRole: "owner", status: "active" },
        ],
        isInstanceAdmin: true,
      }),
      touchBoardApiKey: async () => {},
    })(new Request("http://localhost/api", {
      headers: { authorization: "Bearer valid" },
    }));

    expect(actor).toMatchObject({
      type: "board",
      source: "board_key",
      userId: "user-1",
      keyId: "key-1",
      companyIds: ["company-a"],
    });
  });
});
