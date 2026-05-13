import { describe, expect, it } from "vitest";

import { createSessionStore } from "./session-store.js";

function makeInput(overrides: Partial<Parameters<ReturnType<typeof createSessionStore>["create"]>[0]> = {}) {
  return {
    companyId: "co-1",
    runId: "run-1",
    connectionIds: ["c-1"],
    oauthEnvBindings: [{ envVarName: "GH", connectionId: "c-1" }],
    hostRules: [
      {
        hostname: "api.github.com",
        connectionId: "c-1",
        header: "Authorization",
        format: "Bearer {value}",
      },
    ],
    ttlSeconds: 600,
    ...overrides,
  };
}

describe("SessionStore.create + get", () => {
  it("stores a session retrievable by token", () => {
    const store = createSessionStore();
    const session = store.create(makeInput());
    expect(session.sessionToken).toHaveLength(43); // 32 bytes base64url ≈ 43 chars
    expect(store.get(session.sessionToken)?.runId).toBe("run-1");
  });

  it("issues distinct tokens for distinct sessions", () => {
    const store = createSessionStore();
    const a = store.create(makeInput());
    const b = store.create(makeInput({ runId: "run-2" }));
    expect(a.sessionToken).not.toBe(b.sessionToken);
  });

  it("builds placeholders per env binding (no secret content)", () => {
    const store = createSessionStore();
    const session = store.create(
      makeInput({
        oauthEnvBindings: [
          { envVarName: "GH", connectionId: "c-1" },
          { envVarName: "SL", connectionId: "c-2" },
        ],
        connectionIds: ["c-1", "c-2"],
      }),
    );
    expect(session.placeholders.GH).toMatch(/^__paperclip_broker_c-1_GH__$/);
    expect(session.placeholders.SL).toMatch(/^__paperclip_broker_c-2_SL__$/);
  });

  it("lowercases hostname keys in hostRules for case-insensitive SNI matching", () => {
    const store = createSessionStore();
    const session = store.create(
      makeInput({
        hostRules: [
          {
            hostname: "API.GitHub.COM",
            connectionId: "c-1",
            header: "Authorization",
            format: "Bearer {value}",
          },
        ],
      }),
    );
    expect(session.hostRules.has("api.github.com")).toBe(true);
    expect(session.hostRules.has("API.GitHub.COM")).toBe(false);
  });

  it("returns undefined for unknown session tokens", () => {
    const store = createSessionStore();
    expect(store.get("does-not-exist")).toBeUndefined();
  });
});

describe("SessionStore — bearer cache", () => {
  it("returns the most recently set bearer for a connection on a session", () => {
    const store = createSessionStore();
    const session = store.create(makeInput());
    expect(session.bearerFor("c-1")).toBeUndefined();
    expect(session.setBearer("c-1", "first")).toBe(false);
    expect(session.bearerFor("c-1")).toBe("first");
    expect(session.setBearer("c-1", "second")).toBe(true);
    expect(session.bearerFor("c-1")).toBe("second");
  });

  it("setBearerEverywhere updates every session for the same company that holds the connection", () => {
    const store = createSessionStore();
    const a = store.create(makeInput({ runId: "run-a" }));
    const b = store.create(makeInput({ runId: "run-b" }));
    const other = store.create(
      makeInput({ runId: "run-other", companyId: "co-other" }),
    );
    const touched = store.setBearerEverywhere("co-1", "c-1", "PUSHED");
    expect(touched).toBe(2);
    expect(a.bearerFor("c-1")).toBe("PUSHED");
    expect(b.bearerFor("c-1")).toBe("PUSHED");
    expect(other.bearerFor("c-1")).toBeUndefined();
  });

  it("setBearerEverywhere ignores sessions that don't list the connection in their allowlist", () => {
    const store = createSessionStore();
    const a = store.create(makeInput());
    const noClaim = store.create(
      makeInput({ runId: "run-2", connectionIds: ["c-2"] }),
    );
    const touched = store.setBearerEverywhere("co-1", "c-1", "BEARER");
    expect(touched).toBe(1);
    expect(a.bearerFor("c-1")).toBe("BEARER");
    expect(noClaim.bearerFor("c-1")).toBeUndefined();
  });
});

describe("SessionStore — expiry + revocation", () => {
  it("revoke makes get return undefined", () => {
    const store = createSessionStore();
    const session = store.create(makeInput());
    store.revoke(session.sessionToken);
    expect(store.get(session.sessionToken)).toBeUndefined();
  });

  it("get prunes lazily once a session is past expiresAt", () => {
    const store = createSessionStore();
    const session = store.create(makeInput({ ttlSeconds: 60 }));
    // Force expiry by mutating expiresAt — sanctioned for testing.
    (session as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1);
    expect(store.get(session.sessionToken)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("prune() returns the number of expired sessions dropped", () => {
    const store = createSessionStore();
    const a = store.create(makeInput({ runId: "run-a" }));
    const b = store.create(makeInput({ runId: "run-b" }));
    store.create(makeInput({ runId: "run-c", ttlSeconds: 3600 }));
    (a as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1);
    (b as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1);
    expect(store.prune()).toBe(2);
    expect(store.size()).toBe(1);
  });
});
