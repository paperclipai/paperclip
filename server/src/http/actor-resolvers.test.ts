import { describe, expect, it } from "bun:test";
import { forbidden } from "../errors.js";
import { composeActorResolvers, type ActorResolution } from "./actor-resolvers.js";
import type { HttpActor } from "./actor-context.js";

const actor: HttpActor = {
  type: "board",
  source: "session",
  userId: "user-1",
  companyIds: ["company-a"],
};

describe("HTTP actor resolver composition", () => {
  it("returns the first matched actor", async () => {
    const resolveActor = composeActorResolvers(
      async () => ({ kind: "miss" } satisfies ActorResolution),
      async () => ({ kind: "matched", actor } satisfies ActorResolution),
    );

    await expect(resolveActor(new Request("http://localhost/api"))).resolves.toEqual({
      kind: "matched",
      actor,
    });
  });

  it("falls through only explicit misses", async () => {
    const resolveActor = composeActorResolvers(
      async () => ({ kind: "miss" } satisfies ActorResolution),
      async () => ({ kind: "matched", actor } satisfies ActorResolution),
    );

    await expect(resolveActor(new Request("http://localhost/api"))).resolves.toMatchObject({
      kind: "matched",
    });
  });

  it("stops on an explicit rejection instead of trying another authority", async () => {
    let fallbackCalled = false;
    const resolveActor = composeActorResolvers(
      async () => ({
        kind: "rejected",
        error: forbidden("Invalid agent credentials", { code: "agent_auth_failed" }),
      } satisfies ActorResolution),
      async () => {
        fallbackCalled = true;
        return { kind: "matched", actor } satisfies ActorResolution;
      },
    );

    await expect(resolveActor(new Request("http://localhost/api"))).resolves.toMatchObject({
      kind: "rejected",
    });
    expect(fallbackCalled).toBe(false);
  });

  it("turns resolver exceptions into explicit rejection results", async () => {
    const resolveActor = composeActorResolvers(
      async () => {
        throw new Error("credential backend unavailable");
      },
    );

    const result = await resolveActor(new Request("http://localhost/api"));
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.error).toMatchObject({ status: 500 });
    }
  });

  it("returns a miss when no resolver matches", async () => {
    const resolveActor = composeActorResolvers(
      async () => ({ kind: "miss" } satisfies ActorResolution),
      async () => ({ kind: "miss" } satisfies ActorResolution),
    );

    await expect(resolveActor(new Request("http://localhost/api"))).resolves.toEqual({
      kind: "miss",
    });
  });
});
