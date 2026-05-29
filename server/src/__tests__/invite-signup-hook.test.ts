import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
} from "../auth/better-auth.js";

/**
 * Integration test for the invite-only sign-up `before` hook (TWB-60).
 *
 * Proves the hook is actually wired into Better Auth and fires for
 * `/sign-up/email`: an unsolicited sign-up (no invite token) is rejected with
 * 403 / SIGN_UP_REQUIRES_INVITE *before* any account is created. The reject path
 * short-circuits before the database adapter is touched, so a stub db is enough.
 */

const ORIGINAL_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-twb60";
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_SECRET;
});

function inviteOnlyConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: true,
    allowedHostnames: ["localhost"],
    port: 3100,
  } as unknown as Config;
}

// Stub db whose select() resolves to no invite — exercises the "invalid_invite"
// branch when a token is presented, and is never reached when none is.
function emptyDb() {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  } as never;
}

function createApp(config: Config) {
  const auth = createBetterAuthInstance(emptyDb(), config, []);
  const app = express();
  app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  return app;
}

describe("invite-only sign-up hook", () => {
  it("rejects an unsolicited sign-up (no invite token) with SIGN_UP_REQUIRES_INVITE", async () => {
    const app = createApp(inviteOnlyConfig());
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Content-Type", "application/json")
      .send({ name: "Mallory", email: "mallory@example.com", password: "hunter2hunter2" });

    expect(res.status).toBe(403);
    const code = res.body?.code ?? res.body?.error?.code;
    expect(code).toBe("SIGN_UP_REQUIRES_INVITE");
  });

  it("rejects a sign-up bearing an unknown invite token", async () => {
    const app = createApp(inviteOnlyConfig());
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Content-Type", "application/json")
      .set("x-paperclip-invite-token", "pcp_invite_doesnotexist")
      .send({ name: "Mallory", email: "mallory@example.com", password: "hunter2hunter2" });

    expect(res.status).toBe(403);
    const code = res.body?.code ?? res.body?.error?.code;
    expect(code).toBe("SIGN_UP_REQUIRES_INVITE");
  });

  it("does not gate sign-up when invite-only mode is off (open sign-up reaches the handler)", async () => {
    const app = createApp({ ...inviteOnlyConfig(), authDisableSignUp: false });
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Content-Type", "application/json")
      .send({ name: "Newbie", email: "newbie@example.com", password: "hunter2hunter2" });

    // With open sign-up the hook is a no-op; the request proceeds past the gate
    // into Better Auth's handler (which then fails on the stub db, not with our
    // invite-gate 403). The key assertion is that it is NOT our gate rejection.
    const code = res.body?.code ?? res.body?.error?.code;
    expect(code).not.toBe("SIGN_UP_REQUIRES_INVITE");
  });
});
