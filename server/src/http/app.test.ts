import { describe, expect, it } from "bun:test";
import { forbidden } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpApp, createProtectedHttpApp } from "./app.js";

describe("HTTP application boundary", () => {
  it("serves a no-store health response without opening a listener", async () => {
    const app = createHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
    });

    const response = await app.handle(
      new Request("http://localhost/api/health", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
    });
  });

  it("reports readiness failure without leaking internal configuration", async () => {
    const app = createHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: false,
    });

    const response = await app.handle(
      new Request("http://localhost/api/ready", { method: "GET" }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "not_ready",
      reason: "authentication_not_ready",
    });
  });

  it("maps an unregistered route to the stable 404 JSON contract", async () => {
    const app = createHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
    });

    const response = await app.handle(
      new Request("http://localhost/api/companies", { method: "GET" }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("maps a domain HttpError through the application lifecycle", async () => {
    const app = createHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
    }).get("/api/failure", () => {
      throw forbidden("Access denied", { code: "denied" });
    });

    const response = await app.handle(
      new Request("http://localhost/api/failure", { method: "GET" }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Access denied",
      details: { code: "denied" },
    });
  });

  it("redacts an unexpected application failure", async () => {
    const app = createHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
    }).get("/api/crash", () => {
      throw new Error("secret database connection detail");
    });

    const response = await app.handle(
      new Request("http://localhost/api/crash", { method: "GET" }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("passes an explicitly injected actor to route handlers", async () => {
    const actor: HttpActor = {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      isInstanceAdmin: true,
    };
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => actor,
    }).get("/api/actor", ({ actor: currentActor }) => ({
      type: currentActor.type,
      source: currentActor.source,
    }));

    const response = await app.handle(
      new Request("http://localhost/api/actor", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: "board",
      source: "local_implicit",
    });
  });

  it("fails closed when the injected actor resolver returns no actor", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => null,
    }).get("/api/actor", ({ actor: currentActor }) => currentActor);

    const response = await app.handle(
      new Request("http://localhost/api/actor", { method: "GET" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
