import { describe, expect, it } from "bun:test";
import type { Db } from "@paperclipai/db";
import type { HttpActor } from "./actor-context.js";
import {
  createBoardKeyActorResolver,
  createBoardKeyActorResolutionResolver,
  type BoardAuthResolver,
} from "./board-key-actor-resolver.js";

const boardActor: HttpActor = {
  type: "board",
  source: "board_key",
  userId: "user-1",
  userName: "Board User",
  userEmail: "user@example.com",
  companyIds: ["company-a"],
  memberships: [
    { companyId: "company-a", membershipRole: "owner", status: "active" },
  ],
  isInstanceAdmin: true,
  keyId: "key-1",
  runId: "run-1",
};

describe("board API key actor resolver", () => {
  it("resolves a board bearer token through the existing board auth service", async () => {
    let receivedToken: string | undefined;
    let touchedKey: string | undefined;
    const resolveBoard: BoardAuthResolver = {
      findByToken: async (token) => {
        receivedToken = token;
        return { id: "key-1", userId: "user-1" };
      },
      resolveAccess: async () => ({
        user: { name: "Board User", email: "user@example.com" },
        companyIds: ["company-a"],
        memberships: [
          { companyId: "company-a", membershipRole: "owner", status: "active" },
        ],
        isInstanceAdmin: true,
      }),
      touchKey: async (keyId) => {
        touchedKey = keyId;
      },
    };

    const resolveActor = createBoardKeyActorResolver({} as Db, resolveBoard);
    const actor = await resolveActor(new Request("http://localhost/api/companies", {
      headers: {
        authorization: "Bearer board-token",
        "x-paperclip-run-id": "run-1",
      },
    }));

    expect(receivedToken).toBe("board-token");
    expect(touchedKey).toBe("key-1");
    expect(actor).toEqual(boardActor);
  });

  it("returns null when the authorization header is not a bearer token", async () => {
    const resolveActor = createBoardKeyActorResolver({} as Db, {
      findByToken: async () => {
        throw new Error("must not run");
      },
      resolveAccess: async () => {
        throw new Error("must not run");
      },
      touchKey: async () => {
        throw new Error("must not run");
      },
    });

    await expect(resolveActor(new Request("http://localhost/api/companies"))).resolves.toBeNull();
  });

  it("rejects an empty bearer instead of allowing authentication fallback", async () => {
    let lookupCalled = false;
    const resolve = createBoardKeyActorResolutionResolver({} as Db, {
      findByToken: async () => {
        lookupCalled = true;
        return null;
      },
      resolveAccess: async () => {
        throw new Error("must not run");
      },
      touchKey: async () => {
        throw new Error("must not run");
      },
    });

    const result = await resolve(new Request("http://localhost/api/companies", {
      headers: { authorization: "Bearer   " },
    }));

    expect(result).toMatchObject({
      kind: "rejected",
      error: { status: 401, message: "Empty bearer token; provide valid agent credentials and retry" },
    });
    expect(lookupCalled).toBe(false);
  });

  it("returns null for an unknown or expired board key", async () => {
    const resolveActor = createBoardKeyActorResolver({} as Db, {
      findByToken: async () => null,
      resolveAccess: async () => {
        throw new Error("must not run");
      },
      touchKey: async () => {
        throw new Error("must not run");
      },
    });

    await expect(resolveActor(new Request("http://localhost/api/companies", {
      headers: { authorization: "Bearer missing" },
    }))).resolves.toBeNull();
  });

  it("fails closed when board access lookup fails", async () => {
    const resolveActor = createBoardKeyActorResolver({} as Db, {
      findByToken: async () => ({ id: "key-1", userId: "user-1" }),
      resolveAccess: async () => {
        throw new Error("database unavailable");
      },
      touchKey: async () => {},
    });

    await expect(resolveActor(new Request("http://localhost/api/companies", {
      headers: { authorization: "Bearer board-token" },
    }))).resolves.toBeNull();
  });
});
