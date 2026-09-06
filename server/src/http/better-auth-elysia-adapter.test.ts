import { createDb } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Config } from "../config.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { HttpActor } from "./actor-context.js";
import { createBetterAuthElysiaApp } from "./better-auth-elysia-adapter.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeRealDatabase = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping Better Auth Elysia contract tests: ${support.reason ?? "unsupported environment"}`);
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost/api/auth${path}`, {
    ...init,
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => value.includes(".session_token="));
  expect(cookie).toBeDefined();
  return cookie!.split(";", 1)[0];
}

describeRealDatabase("Better Auth Elysia adapter contract", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let app: ReturnType<typeof createBetterAuthElysiaApp>;
  let auth: ReturnType<typeof createBetterAuthInstance>;
  const actor: HttpActor = { type: "board", source: "local_implicit", isInstanceAdmin: true };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-elysia-");
    const db = createDb(database.connectionString);
    const config = {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      authDisableSignUp: false,
      port: 3100,
    } as Config;
    process.env.BETTER_AUTH_SECRET = "better-auth-elysia-contract-test-secret";
    auth = createBetterAuthInstance(db, config, ["http://localhost"]);
    app = createBetterAuthElysiaApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => actor,
      auth,
    });
  }, 30_000);

  afterAll(async () => {
    delete process.env.BETTER_AUTH_SECRET;
    await database?.cleanup();
  });

  it("does not resolve an actor for public Better Auth routes", async () => {
    let resolverCalls = 0;
    const publicApp = createBetterAuthElysiaApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => {
        resolverCalls += 1;
        return actor;
      },
      auth,
    });

    const response = await publicApp.handle(request("/get-session", { method: "GET" }));

    expect(response.status).toBe(200);
    expect(resolverCalls).toBe(0);
  });

  it("fails closed for protected routes without an actor", async () => {
    const protectedApp = createBetterAuthElysiaApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => null,
      auth,
    }).get("/api/protected-test", () => "protected");

    const response = await protectedApp.handle(
      new Request("http://localhost/api/protected-test", { method: "GET" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("round-trips sign-up, sign-in, session read and sign-out with real PostgreSQL", async () => {
    const credentials = {
      name: "Elysia Contract User",
      email: "elysia-contract@example.test",
      password: "correct-horse-battery-staple",
    };
    const signUp = await app.handle(request("/sign-up/email", { method: "POST", body: JSON.stringify(credentials) }));
    expect(signUp.status).toBe(200);
    const signUpCookie = cookieFrom(signUp);
    expect(signUp.headers.get("set-cookie")).toContain("session_token");

    const signIn = await app.handle(request("/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    }));
    expect(signIn.status).toBe(200);
    const cookie = cookieFrom(signIn);
    expect(cookie).not.toBe(signUpCookie);

    const session = await app.handle(request("/get-session", { method: "GET", headers: { cookie } }));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: credentials.email } });

    const logout = await app.handle(request("/sign-out", { method: "POST", headers: { cookie } }));
    expect(logout.status).toBe(200);
    const afterLogout = await app.handle(request("/get-session", { method: "GET", headers: { cookie } }));
    expect(afterLogout.status).toBe(200);
    expect(await afterLogout.json()).toBeNull();
  }, 30_000);

  it("preserves Better Auth failures for absent and invalid credentials", async () => {
    const absent = await app.handle(request("/get-session", { method: "GET" }));
    expect(absent.status).toBe(200);
    expect(await absent.json()).toBeNull();

    const invalid = await app.handle(request("/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "missing@example.test", password: "wrong-password" }),
    }));
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(invalid.headers.get("content-type")).toContain("application/json");
  });

  it("accepts only Better Auth GET and POST methods and returns 405 otherwise", async () => {
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await app.handle(request("/get-session", { method }));
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "Method Not Allowed" });
    }
  });
});
