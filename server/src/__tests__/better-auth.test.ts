import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";

const { toNodeHandlerMock } = vi.hoisted(() => ({
  toNodeHandlerMock: vi.fn(),
}));

vi.mock("better-auth/node", () => ({
  toNodeHandler: toNodeHandlerMock,
}));

import {
  buildBetterAuthAdvancedOptions,
  createBetterAuthHandler,
  deriveAuthCookiePrefix,
  deriveAuthTrustedOrigins,
} from "../auth/better-auth.js";

const ORIGINAL_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (ORIGINAL_INSTANCE_ID === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_INSTANCE_ID;
  toNodeHandlerMock.mockReset();
});

describe("Better Auth cookie scoping", () => {
  it("derives an instance-scoped cookie prefix", () => {
    expect(deriveAuthCookiePrefix("default")).toBe("paperclip-default");
    expect(deriveAuthCookiePrefix("PAP-1601-worktree")).toBe("paperclip-PAP-1601-worktree");
  });

  it("uses PAPERCLIP_INSTANCE_ID for the Better Auth cookie prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "sat-worktree";

    const advanced = buildBetterAuthAdvancedOptions({ disableSecureCookies: false });

    expect(advanced).toEqual({
      cookiePrefix: "paperclip-sat-worktree",
    });
    expect(getCookies({ advanced } as BetterAuthOptions).sessionToken.name).toBe(
      "paperclip-sat-worktree.session_token",
    );
  });

  it("keeps local http auth cookies non-secure while preserving the scoped prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "pap-worktree";

    expect(buildBetterAuthAdvancedOptions({ disableSecureCookies: true })).toEqual({
      cookiePrefix: "paperclip-pap-worktree",
      useSecureCookies: false,
    });
  });

  it("adds hostname port variants for authenticated mode on non-default ports", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["Board.Example.Test"],
      port: 3101,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0]);

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test",
      "http://board.example.test",
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
  });

  it("prefers an explicit resolved listen port over the configured port", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["board.example.test"],
      port: 3100,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0], { listenPort: 3101 });

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
    expect(trustedOrigins).not.toContain("https://board.example.test:3100");
    expect(trustedOrigins).not.toContain("http://board.example.test:3100");
  });
});

describe("Better Auth request handler", () => {
  function buildAuthApp() {
    const app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler({} as never));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status((err as { status?: number })?.status ?? 500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return app;
  }

  it("finishes successful auth responses without waiting for next()", async () => {
    let calls = 0;
    toNodeHandlerMock.mockReturnValue(async (_req: express.Request, res: express.Response) => {
      calls += 1;
      res.status(200).json({ ok: true });
    });

    await expect(request(buildAuthApp()).post("/api/auth/sign-in/email")).resolves.toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect(calls).toBe(1);
  });

  it("retries one retryable sign-in handler failure", async () => {
    let calls = 0;
    toNodeHandlerMock.mockReturnValue(async (_req: express.Request, res: express.Response) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("database connection dropped"), { status: 500 });
      }
      res.status(200).json({ ok: true });
    });

    await expect(request(buildAuthApp()).post("/api/auth/sign-in/email")).resolves.toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect(calls).toBe(2);
  });

  it("does not retry non-sign-in auth handler failures", async () => {
    let calls = 0;
    toNodeHandlerMock.mockReturnValue(async () => {
      calls += 1;
      throw Object.assign(new Error("database connection dropped"), { status: 500 });
    });

    await expect(request(buildAuthApp()).post("/api/auth/sign-out")).resolves.toMatchObject({
      status: 500,
      body: { error: "database connection dropped" },
    });
    expect(calls).toBe(1);
  });
});
