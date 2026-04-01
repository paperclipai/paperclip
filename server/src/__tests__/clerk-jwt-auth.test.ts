import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import {
  resetClerkJwksCacheForTests,
  resolveClerkSessionFromHeaders,
} from "../auth/better-auth.js";

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signJwt(
  claims: Record<string, unknown>,
  options?: {
    kid?: string;
    privateKeyPem?: string;
  },
) {
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: options?.kid ?? "test-kid",
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(options?.privateKeyPem ?? rsaKeys.privateKeyPem, "base64url");
  return `${signingInput}.${signature}`;
}

const rsaKeys = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicJwk: publicKey.export({ format: "jwk" }),
  };
})();

const rotatedKeys = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicJwk: publicKey.export({ format: "jwk" }),
  };
})();

function createHeaders(token?: string) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

function createMockDb(existingUser?: { id: string; email: string; name: string | null }) {
  const state = {
    selectedUser: existingUser ?? null,
    insertedUsers: [] as Array<Record<string, unknown>>,
  };

  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(state.selectedUser ? [state.selectedUser] : []),
      }),
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        state.insertedUsers.push(value);
        const inserted = {
          id: String(value.id),
          email: String(value.email),
          name: value.name == null ? null : String(value.name),
        };
        state.selectedUser = inserted;
        return Promise.resolve([inserted]);
      },
    }),
  };

  return { db, state };
}

describe("Clerk JWT auth", () => {
  const originalEnv = {
    jwksUrl: process.env.CLERK_JWKS_URL,
    issuer: process.env.CLERK_ISSUER,
    publicBaseUrl: process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL,
    authorizedParties: process.env.CLERK_AUTHORIZED_PARTIES,
  };

  beforeEach(() => {
    process.env.CLERK_JWKS_URL = "https://clerk.example.test/.well-known/jwks.json";
    process.env.CLERK_ISSUER = "https://clerk.example.test";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
    resetClerkJwksCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetClerkJwksCacheForTests();
    if (originalEnv.jwksUrl === undefined) delete process.env.CLERK_JWKS_URL;
    else process.env.CLERK_JWKS_URL = originalEnv.jwksUrl;
    if (originalEnv.issuer === undefined) delete process.env.CLERK_ISSUER;
    else process.env.CLERK_ISSUER = originalEnv.issuer;
    if (originalEnv.publicBaseUrl === undefined) delete process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL;
    else process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = originalEnv.publicBaseUrl;
    if (originalEnv.authorizedParties === undefined) delete process.env.CLERK_AUTHORIZED_PARTIES;
    else process.env.CLERK_AUTHORIZED_PARTIES = originalEnv.authorizedParties;
  });

  it("returns a session for a valid Clerk JWT using cached JWKS", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ ...rsaKeys.publicJwk, kid: "test-kid", alg: "RS256", use: "sig" }] }),
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { db } = createMockDb({ id: "user-existing", email: "austin@example.com", name: "Austin" });
    const token = signJwt({
      sub: "clerk_user_123",
      email: "austin@example.com",
      name: "Austin",
      iss: "https://clerk.example.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nbf: Math.floor(Date.now() / 1000) - 60,
    });

    const first = await resolveClerkSessionFromHeaders(db as never, createHeaders(token));
    const second = await resolveClerkSessionFromHeaders(db as never, createHeaders(token));

    expect(first).toEqual({
      session: { id: "clerk:clerk_user_123", userId: "user-existing" },
      user: { id: "user-existing", email: "austin@example.com", name: "Austin" },
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null for an expired Clerk JWT", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ ...rsaKeys.publicJwk, kid: "test-kid", alg: "RS256", use: "sig" }] }),
      headers: new Headers(),
    }));
    const { db } = createMockDb({ id: "user-existing", email: "austin@example.com", name: "Austin" });
    const token = signJwt({
      sub: "clerk_user_123",
      email: "austin@example.com",
      name: "Austin",
      iss: "https://clerk.example.test",
      exp: Math.floor(Date.now() / 1000) - 10,
      nbf: Math.floor(Date.now() / 1000) - 60,
    });

    await expect(resolveClerkSessionFromHeaders(db as never, createHeaders(token))).resolves.toBeNull();
  });

  it("returns null for an invalid signature", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ ...rsaKeys.publicJwk, kid: "test-kid", alg: "RS256", use: "sig" }] }),
      headers: new Headers(),
    }));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { db } = createMockDb({ id: "user-existing", email: "austin@example.com", name: "Austin" });
    const token = signJwt(
      {
        sub: "clerk_user_123",
        email: "austin@example.com",
        name: "Austin",
        iss: "https://clerk.example.test",
        exp: Math.floor(Date.now() / 1000) + 3600,
        nbf: Math.floor(Date.now() / 1000) - 60,
      },
      { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    );

    await expect(resolveClerkSessionFromHeaders(db as never, createHeaders(token))).resolves.toBeNull();
  });

  it("returns null when azp does not match the configured auth origin", async () => {
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = "https://app.paperclip.test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ ...rsaKeys.publicJwk, kid: "test-kid", alg: "RS256", use: "sig" }] }),
      headers: new Headers(),
    }));
    const { db } = createMockDb({ id: "user-existing", email: "austin@example.com", name: "Austin" });
    const token = signJwt({
      sub: "clerk_user_123",
      azp: "https://evil.example.test",
      email: "austin@example.com",
      name: "Austin",
      iss: "https://clerk.example.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nbf: Math.floor(Date.now() / 1000) - 60,
    });

    await expect(resolveClerkSessionFromHeaders(db as never, createHeaders(token))).resolves.toBeNull();
  });

  it("returns null immediately when Clerk auth env vars are not set", async () => {
    delete process.env.CLERK_JWKS_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db } = createMockDb();
    const token = signJwt({
      sub: "clerk_user_123",
      email: "austin@example.com",
      name: "Austin",
      iss: "https://clerk.example.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nbf: Math.floor(Date.now() / 1000) - 60,
    });

    await expect(resolveClerkSessionFromHeaders(db as never, createHeaders(token))).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto-provisions a new user when the email does not exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ ...rsaKeys.publicJwk, kid: "test-kid", alg: "RS256", use: "sig" }] }),
      headers: new Headers(),
    }));
    const { db, state } = createMockDb();
    const token = signJwt({
      sub: "clerk_user_999",
      email: "new-user@example.com",
      name: "New User",
      iss: "https://clerk.example.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nbf: Math.floor(Date.now() / 1000) - 60,
    });

    const result = await resolveClerkSessionFromHeaders(db as never, createHeaders(token));

    expect(state.insertedUsers).toHaveLength(1);
    expect(state.insertedUsers[0]).toMatchObject({
      email: "new-user@example.com",
      name: "New User",
      emailVerified: true,
      image: null,
    });
    expect(result?.user?.email).toBe("new-user@example.com");
    expect(result?.session?.userId).toBe(String(state.insertedUsers[0]?.id));
  });

  it("returns an existing user session when the email already exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ ...rsaKeys.publicJwk, kid: "test-kid", alg: "RS256", use: "sig" }] }),
      headers: new Headers(),
    }));
    const { db, state } = createMockDb({
      id: "user-existing",
      email: "austin@example.com",
      name: "Austin",
    });
    const token = signJwt({
      sub: "clerk_user_123",
      email: "austin@example.com",
      name: "Austin",
      iss: "https://clerk.example.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nbf: Math.floor(Date.now() / 1000) - 60,
    });

    const result = await resolveClerkSessionFromHeaders(db as never, createHeaders(token));

    expect(state.insertedUsers).toHaveLength(0);
    expect(result).toEqual({
      session: { id: "clerk:clerk_user_123", userId: "user-existing" },
      user: { id: "user-existing", email: "austin@example.com", name: "Austin" },
    });
  });

  it("returns null when there is no Authorization header", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db } = createMockDb();

    await expect(resolveClerkSessionFromHeaders(db as never, new Headers())).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes the JWKS cache on unknown kid and retries verification", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [{ ...rsaKeys.publicJwk, kid: "old-kid", alg: "RS256", use: "sig" }] }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [{ ...rotatedKeys.publicJwk, kid: "rotated-kid", alg: "RS256", use: "sig" }] }),
        headers: new Headers(),
      });
    vi.stubGlobal("fetch", fetchMock);
    const { db } = createMockDb({ id: "user-existing", email: "austin@example.com", name: "Austin" });
    const token = signJwt(
      {
        sub: "clerk_user_123",
        email: "austin@example.com",
        name: "Austin",
        iss: "https://clerk.example.test",
        exp: Math.floor(Date.now() / 1000) + 3600,
        nbf: Math.floor(Date.now() / 1000) - 60,
      },
      { kid: "rotated-kid", privateKeyPem: rotatedKeys.privateKeyPem },
    );

    const result = await resolveClerkSessionFromHeaders(db as never, createHeaders(token));

    expect(result?.user?.id).toBe("user-existing");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
