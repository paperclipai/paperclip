import { createDb } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping managed loopback auth tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function authRequest(origin: string, path: string, init?: RequestInit): Request {
  return new Request(`${origin}/api/auth${path}`, {
    ...init,
    headers: {
      origin,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes(".session_token="));
  expect(cookie).toBeDefined();
  return cookie!;
}

describeEmbeddedPostgres("managed runtime loopback auth cookies", () => {
  const publicOrigin = "https://worktree.example.test";
  const loopbackOrigin = "http://127.0.0.1:42013";
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-managed-loopback-auth-");
  }, 20_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await tempDb?.cleanup();
  });

  it("uses a loopback sign-in cookie on the next request while keeping the public cookie secure", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "managed-loopback-auth-test-secret");
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", publicOrigin);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");

    const db = createDb(tempDb!.connectionString);
    const config = {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: publicOrigin,
      authDisableSignUp: false,
    } as Config;
    const auth = createBetterAuthInstance(db, config, [publicOrigin, loopbackOrigin]);
    const credentials = {
      name: "Loopback Operator",
      email: "loopback-operator@example.test",
      password: "correct-horse-battery-staple",
    };

    const signUpResponse = await auth.handler(authRequest(publicOrigin, "/sign-up/email", {
      method: "POST",
      body: JSON.stringify(credentials),
    }));
    expect(signUpResponse.status).toBe(200);
    expect(sessionCookie(signUpResponse)).toMatch(/;\s*Secure(?:;|$)/i);

    const signInResponse = await auth.handler(authRequest(loopbackOrigin, "/sign-in/email", {
      method: "POST",
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    }));
    expect(signInResponse.status).toBe(200);
    const loopbackCookie = sessionCookie(signInResponse);
    expect(loopbackCookie).not.toMatch(/;\s*Secure(?:;|$)/i);

    const getSessionResponse = await auth.handler(authRequest(loopbackOrigin, "/get-session", {
      method: "GET",
      headers: {
        cookie: loopbackCookie.split(";", 1)[0],
      },
    }));
    expect(getSessionResponse.status).toBe(200);
    await expect(getSessionResponse.json()).resolves.toMatchObject({
      user: { email: credentials.email },
    });
  });
});
