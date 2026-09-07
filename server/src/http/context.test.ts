import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import type { HttpActor } from "./actor-context.js";
import { withActorContext } from "./context.js";
import { toHttpErrorResponse } from "./errors.js";

const actor: HttpActor = {
  type: "board",
  source: "local_implicit",
  userId: "local-board",
  isInstanceAdmin: true,
};

describe("HTTP request context", () => {
  it("exposes an explicitly supplied actor to a route", async () => {
    const app = new Elysia()
      .onError(({ error, code }) => toHttpErrorResponse(error, code === "NOT_FOUND" ? "NOT_FOUND" : undefined))
      .use(withActorContext(() => actor))
      .get("/api/context", ({ actor: currentActor }) => ({
        actorType: currentActor.type,
        source: currentActor.source,
      }));

    const response = await app.handle(
      new Request("http://localhost/api/context", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      actorType: "board",
      source: "local_implicit",
    });
  });

  it("rejects a request when the actor resolver returns no actor", async () => {
    const app = new Elysia()
      .onError(({ error, code }) => toHttpErrorResponse(error, code === "NOT_FOUND" ? "NOT_FOUND" : undefined))
      .use(withActorContext(() => null))
      .get("/api/context", ({ actor: currentActor }) => currentActor);

    const response = await app.handle(
      new Request("http://localhost/api/context", { method: "GET" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
