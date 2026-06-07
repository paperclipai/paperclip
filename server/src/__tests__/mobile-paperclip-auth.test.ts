import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  isMobilePaperclipPublicHostname,
  mobilePaperclipAuthGuard,
  type MobilePaperclipAuthGuardOptions,
  type MobilePaperclipBoardAccess,
  type MobilePaperclipBoardUser,
} from "../middleware/mobile-paperclip-auth.js";

const SECRET_ENV = "MOBILE_PAPERCLIP_JWT_SECRET";

const DEFAULT_USER: MobilePaperclipBoardUser = {
  id: "user_jarvis_real_id",
  name: "Jarvis Chen",
  email: "jarvisrchen@gmail.com",
};

const DEFAULT_ACCESS: MobilePaperclipBoardAccess = {
  companyIds: ["company_jarvis"],
  memberships: [
    { companyId: "company_jarvis", membershipRole: "admin", status: "active" },
  ],
  isInstanceAdmin: false,
};

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signJwt(opts: {
  secret: string;
  sub?: string;
  email?: string | null;
  iss?: string;
  aud?: string;
  exp?: number;
  pcRole?: string;
}) {
  const header = { alg: "HS256", typ: "JWT" };
  const claims: Record<string, unknown> = {
    sub: opts.sub ?? "rchen",
    iat: Math.floor(Date.now() / 1000),
    exp: opts.exp ?? Math.floor(Date.now() / 1000) + 300,
    iss: opts.iss ?? "mobile-paperclip",
    aud: opts.aud ?? "paperclip-server",
  };
  if (opts.pcRole !== undefined) claims.pcRole = opts.pcRole;
  // Default: include the user's email so the guard can resolve a real userId.
  // Pass `email: null` explicitly to omit the claim (covers legacy tokens).
  if (opts.email !== null) {
    claims.email = opts.email ?? DEFAULT_USER.email;
  }
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = createHmac("sha256", opts.secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function makeReq(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    headers: lower,
    header(name: string) {
      return lower[name.toLowerCase()];
    },
    actor: { type: "board", source: "local_implicit" },
  } as unknown as Request;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

interface GuardOverrides {
  enabled?: boolean;
  publicHostnames?: Set<string>;
  resolveUserByEmail?: MobilePaperclipAuthGuardOptions["resolveUserByEmail"];
  resolveBoardAccess?: MobilePaperclipAuthGuardOptions["resolveBoardAccess"];
}

function buildGuard(overrides: GuardOverrides = {}) {
  return mobilePaperclipAuthGuard({
    enabled: overrides.enabled ?? true,
    publicHostnames:
      overrides.publicHostnames ?? new Set(["paperclip-rchen.api.example.com"]),
    resolveUserByEmail:
      overrides.resolveUserByEmail ?? (async (email) =>
        email === DEFAULT_USER.email ? DEFAULT_USER : null),
    resolveBoardAccess:
      overrides.resolveBoardAccess ?? (async () => DEFAULT_ACCESS),
  });
}

async function runGuard(
  guard: ReturnType<typeof buildGuard>,
  req: Request,
  res: Response & { statusCode: number; body: unknown },
): Promise<{ calledNext: boolean; nextErr: unknown }> {
  let calledNext = false;
  let nextErr: unknown = undefined;
  await guard(req, res, ((err?: unknown) => {
    calledNext = true;
    nextErr = err;
  }) as NextFunction);
  return { calledNext, nextErr };
}

describe("isMobilePaperclipPublicHostname", () => {
  it("returns false for loopback even when in the allowlist", () => {
    expect(
      isMobilePaperclipPublicHostname("localhost", new Set(["localhost", "paperclip-rchen.api.example.com"])),
    ).toBe(false);
    expect(
      isMobilePaperclipPublicHostname("127.0.0.1", new Set(["127.0.0.1"])),
    ).toBe(false);
  });

  it("returns true only for hostnames present in the public set", () => {
    const set = new Set(["paperclip-rchen.api.example.com"]);
    expect(isMobilePaperclipPublicHostname("paperclip-rchen.api.example.com", set)).toBe(true);
    expect(isMobilePaperclipPublicHostname("evil.example.com", set)).toBe(false);
    expect(isMobilePaperclipPublicHostname(null, set)).toBe(false);
  });
});

describe("mobilePaperclipAuthGuard", () => {
  const originalEnv = process.env[SECRET_ENV];

  beforeEach(() => {
    process.env[SECRET_ENV] = "test-mobile-secret";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = originalEnv;
  });

  it("is a no-op when disabled", async () => {
    const guard = buildGuard({ enabled: false });
    const req = makeReq({ host: "paperclip-rchen.api.example.com" });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(true);
  });

  it("is a no-op when public-hostname set is empty", async () => {
    const guard = buildGuard({ publicHostnames: new Set() });
    const req = makeReq({ host: "paperclip-rchen.api.example.com" });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(true);
  });

  it("passes loopback requests through without requiring a JWT", async () => {
    const guard = buildGuard();
    const req = makeReq({ host: "localhost:3100" });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(true);
    expect(req.actor.source).toBe("local_implicit");
  });

  it("rejects public-hostname requests without a bearer token", async () => {
    const guard = buildGuard();
    const req = makeReq({ host: "paperclip-rchen.api.example.com" });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("rejects public-hostname requests with a bogus bearer token", async () => {
    const guard = buildGuard();
    const req = makeReq({
      host: "paperclip-rchen.api.example.com",
      authorization: "Bearer not-a-valid-jwt",
    });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("rejects valid JWTs that are missing the email claim", async () => {
    const token = signJwt({ secret: "test-mobile-secret", email: null });
    const guard = buildGuard();
    const req = makeReq({
      host: "paperclip-rchen.api.example.com",
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string } | undefined)?.error).toMatch(/email claim/);
  });

  it("rejects emails that are not registered as board users", async () => {
    const token = signJwt({
      secret: "test-mobile-secret",
      email: "stranger@example.com",
    });
    const guard = buildGuard({
      resolveUserByEmail: async () => null,
    });
    const req = makeReq({
      host: "paperclip-rchen.api.example.com",
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error?: string } | undefined)?.error).toMatch(/board user/);
  });

  it("resolves email to a real auth user id and populates board access", async () => {
    const token = signJwt({
      secret: "test-mobile-secret",
      email: DEFAULT_USER.email,
    });
    const lookupCalls: string[] = [];
    const accessCalls: string[] = [];
    const guard = buildGuard({
      resolveUserByEmail: async (email) => {
        lookupCalls.push(email);
        return DEFAULT_USER;
      },
      resolveBoardAccess: async (userId) => {
        accessCalls.push(userId);
        return DEFAULT_ACCESS;
      },
    });
    const req = makeReq({
      host: "paperclip-rchen.api.example.com",
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(true);
    expect(req.actor).toMatchObject({
      type: "board",
      userId: DEFAULT_USER.id,
      userEmail: DEFAULT_USER.email,
      userName: DEFAULT_USER.name,
      companyIds: DEFAULT_ACCESS.companyIds,
      memberships: DEFAULT_ACCESS.memberships,
      isInstanceAdmin: false,
      source: "mobile_paperclip_jwt",
    });
    // Ensure userId is the real id, not the legacy synthetic placeholder.
    expect(req.actor.userId).not.toMatch(/^mobile-paperclip:/);
    expect(lookupCalls).toEqual([DEFAULT_USER.email.toLowerCase()]);
    expect(accessCalls).toEqual([DEFAULT_USER.id]);
  });

  it("normalises email casing before lookup", async () => {
    const token = signJwt({
      secret: "test-mobile-secret",
      email: "Jarvis.Mixed.CASE@gmail.com",
    });
    const lookupCalls: string[] = [];
    const guard = buildGuard({
      resolveUserByEmail: async (email) => {
        lookupCalls.push(email);
        return { ...DEFAULT_USER, email: "Jarvis.Mixed.CASE@gmail.com" };
      },
    });
    const req = makeReq({
      host: "paperclip-rchen.api.example.com",
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(true);
    expect(lookupCalls).toEqual(["jarvis.mixed.case@gmail.com"]);
  });

  it("does not grant instance-admin rights when pcRole is missing or non-admin and access does not grant it", async () => {
    const guard = buildGuard();
    for (const pcRole of [undefined, "viewer", "instance_user", "INSTANCE_ADMIN"]) {
      const token = signJwt({ secret: "test-mobile-secret", pcRole });
      const req = makeReq({
        host: "paperclip-rchen.api.example.com",
        authorization: `Bearer ${token}`,
      });
      const res = makeRes();
      const { calledNext } = await runGuard(guard, req, res);
      expect(calledNext).toBe(true);
      expect(req.actor).toMatchObject({
        type: "board",
        userId: DEFAULT_USER.id,
        isInstanceAdmin: false,
        source: "mobile_paperclip_jwt",
      });
    }
  });

  it("grants instance-admin rights when pcRole is exactly 'instance_admin'", async () => {
    const token = signJwt({
      secret: "test-mobile-secret",
      pcRole: "instance_admin",
    });
    const guard = buildGuard();
    const req = makeReq({
      host: "paperclip-rchen.api.example.com",
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(true);
    expect(req.actor).toMatchObject({
      type: "board",
      userId: DEFAULT_USER.id,
      isInstanceAdmin: true,
      source: "mobile_paperclip_jwt",
    });
  });

  it("also grants instance-admin when board access carries the instance-admin role", async () => {
    const token = signJwt({ secret: "test-mobile-secret" });
    const guard = buildGuard({
      resolveBoardAccess: async () => ({ ...DEFAULT_ACCESS, isInstanceAdmin: true }),
    });
    const req = makeReq({
      host: "paperclip-rchen.api.example.com",
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    expect(calledNext).toBe(true);
    expect(req.actor.isInstanceAdmin).toBe(true);
  });

  it("respects x-forwarded-host over host", async () => {
    const guard = buildGuard();
    const req = makeReq({
      host: "localhost:3100",
      "x-forwarded-host": "paperclip-rchen.api.example.com",
    });
    const res = makeRes();
    const { calledNext } = await runGuard(guard, req, res);
    // Without auth, public-hostname enforcement should reject even though host header is loopback.
    expect(calledNext).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
