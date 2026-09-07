import { describe, expect, it } from "bun:test";
import type { BetterAuthSessionResolver, BetterAuthSessionResult } from "../auth/better-auth.js";
import type { HttpActor } from "./actor-context.js";
import { createSessionActorResolver } from "./session-actor-resolver.js";

const sessionResult: BetterAuthSessionResult = {
  session: { id: "session-1", userId: "user-1" },
  user: { id: "user-1", email: "user@example.com", name: "Board User" },
};

describe("session actor resolver", () => {
  it("maps a Better Auth session to a typed board actor", async () => {
    let receivedHeaders: Headers | undefined;
    const auth: BetterAuthSessionResolver = {
      api: {
        getSession: async ({ headers }) => {
          receivedHeaders = headers;
          return sessionResult;
        },
      },
    };
    const resolveActor = createSessionActorResolver(auth, async () => ({
      memberships: [
        { companyId: "company-a", membershipRole: "member", status: "active" },
      ],
      isInstanceAdmin: false,
    }));

    const request = new Request("http://localhost/api/companies", {
      headers: { cookie: "better-auth.session_token=test" },
    });
    const actor = await resolveActor(request);

    expect(receivedHeaders).toBeInstanceOf(Headers);
    expect(receivedHeaders?.get("cookie")).toContain("better-auth.session_token=test");
    expect(actor).toEqual({
      type: "board",
      source: "session",
      userId: "user-1",
      userName: "Board User",
      userEmail: "user@example.com",
      sessionId: "session-1",
      companyIds: ["company-a"],
      memberships: [
        { companyId: "company-a", membershipRole: "member", status: "active" },
      ],
      isInstanceAdmin: false,
    } satisfies HttpActor);
  });

  it("returns null when Better Auth has no session", async () => {
    const auth: BetterAuthSessionResolver = {
      api: { getSession: async () => null },
    };
    const resolveActor = createSessionActorResolver(auth, async () => ({
      memberships: [],
      isInstanceAdmin: false,
    }));

    await expect(resolveActor(new Request("http://localhost/api/companies"))).resolves.toBeNull();
  });

  it("fails closed when membership loading fails", async () => {
    const auth: BetterAuthSessionResolver = {
      api: { getSession: async () => sessionResult },
    };
    const resolveActor = createSessionActorResolver(auth, async () => {
      throw new Error("membership database unavailable");
    });

    await expect(resolveActor(new Request("http://localhost/api/companies"))).resolves.toBeNull();
  });
});
