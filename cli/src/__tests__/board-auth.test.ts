import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStoredBoardCredential,
  loginBoardCli,
  readBoardAuthStore,
  removeStoredBoardCredential,
  setStoredBoardCredential,
} from "../client/board-auth.js";

function createTempAuthPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-auth-"));
  return path.join(dir, "auth.json");
}

describe("board auth store", () => {
  it("returns an empty store when the file does not exist", () => {
    const authPath = createTempAuthPath();
    expect(readBoardAuthStore(authPath)).toEqual({
      version: 1,
      credentials: {},
    });
  });

  it("stores and retrieves credentials by normalized api base", () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100/",
      token: "token-123",
      userId: "user-1",
      storePath: authPath,
    });

    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toMatchObject({
      apiBase: "http://localhost:3100",
      token: "token-123",
      userId: "user-1",
    });
  });

  it("removes stored credentials", () => {
    const authPath = createTempAuthPath();
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "token-123",
      storePath: authPath,
    });

    expect(removeStoredBoardCredential("http://localhost:3100", authPath)).toBe(true);
    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toBeNull();
  });
});


describe("board CLI polling backoff", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function harness(statuses: Array<{ status: number; body: unknown; retryAfter?: string }>, expiresIn = 10_000) {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const authPath = createTempAuthPath();
    const created = { id: "12345678-1234-4123-8123-123456789abc", token: "synthetic-challenge-capability",
      boardApiToken: "synthetic-board-token", approvalPath: "/cli-auth/approve", approvalUrl: null,
      pollPath: "/cli-auth/challenges/12345678-1234-4123-8123-123456789abc",
      expiresAt: new Date(Date.now() + expiresIn).toISOString(), suggestedPollIntervalMs: 1000 };
    let creates = 0, polls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") { creates++; return new Response(JSON.stringify(created), { status: 201 }); }
      if (String(url).endsWith("/cli-auth/me")) return new Response(JSON.stringify({ userId: "synthetic-user" }));
      polls++;
      const next = statuses.shift();
      if (!next) throw new Error("Unexpected additional poll");
      return new Response(JSON.stringify(next.body), { status: next.status,
        headers: next.retryAfter === undefined ? undefined : { "Retry-After": next.retryAfter } });
    });
    vi.stubGlobal("fetch", fetcher);
    const outcome = loginBoardCli({ apiBase: "https://cli.example.invalid", requestedAccess: "board", storePath: authPath,
      openBrowser: false, print: false }).then(value => ({ value }), error => ({ error }));
    return { authPath, created, outcome, counts: () => ({ creates, polls }), cleanup: () => fs.rmSync(path.dirname(authPath), { recursive: true, force: true }) };
  }

  it("waits for numeric Retry-After and persists the original approved key", async () => {
    const f = harness([{ status: 429, body: { error: "Rate limited" }, retryAfter: "2" }, { status: 200, body: { status: "approved" } }]);
    try {
      await vi.advanceTimersByTimeAsync(1999);
      expect(f.counts()).toEqual({ creates: 1, polls: 1 });
      expect(getStoredBoardCredential("https://cli.example.invalid", f.authPath)).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(await f.outcome).toHaveProperty("value.token", f.created.boardApiToken);
      expect(getStoredBoardCredential("https://cli.example.invalid", f.authPath)?.token).toBe(f.created.boardApiToken);
      expect(f.counts()).toEqual({ creates: 1, polls: 2 });
    } finally { f.cleanup(); }
  });

  it.each([undefined, "not-a-time", "-1", "0"])("uses normal polling when Retry-After is %s", async retryAfter => {
    const f = harness([{ status: 429, body: { error: "Rate limited" }, retryAfter }, { status: 200, body: { status: "approved" } }]);
    try {
      await vi.advanceTimersByTimeAsync(999); expect(f.counts()).toEqual({ creates: 1, polls: 1 });
      await vi.advanceTimersByTimeAsync(1); expect(await f.outcome).toHaveProperty("value.token", f.created.boardApiToken);
      expect(f.counts()).toEqual({ creates: 1, polls: 2 });
    } finally { f.cleanup(); }
  });

  it("honors an HTTP-date Retry-After", async () => {
    const f = harness([{ status: 429, body: { error: "Rate limited" }, retryAfter: "Thu, 01 Jan 2026 00:00:02 GMT" },
      { status: 200, body: { status: "approved" } }]);
    try { await vi.advanceTimersByTimeAsync(2000); expect(await f.outcome).toHaveProperty("value.token", f.created.boardApiToken); }
    finally { f.cleanup(); }
  });

  it("never extends the original challenge deadline for a long Retry-After", async () => {
    const f = harness([{ status: 429, body: { error: "Rate limited" }, retryAfter: "3600" }], 1500);
    try {
      await vi.advanceTimersByTimeAsync(1500);
      expect(await f.outcome).toHaveProperty("error.message", "CLI auth challenge expired before approval.");
      expect(f.counts()).toEqual({ creates: 1, polls: 1 });
      expect(getStoredBoardCredential("https://cli.example.invalid", f.authPath)).toBeNull();
    } finally { f.cleanup(); }
  });

  it.each(["cancelled", "expired"])("preserves %s after a rate-limit wait", async status => {
    const f = harness([{ status: 429, body: { error: "Rate limited" }, retryAfter: "1" }, { status: 200, body: { status } }]);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(await f.outcome).toHaveProperty("error.message", status === "cancelled" ? "CLI auth challenge was cancelled." : "CLI auth challenge expired before approval.");
      expect(f.counts()).toEqual({ creates: 1, polls: 2 });
      expect(getStoredBoardCredential("https://cli.example.invalid", f.authPath)).toBeNull();
    } finally { f.cleanup(); }
  });

  it("does not retry other HTTP failures", async () => {
    const f = harness([{ status: 503, body: { error: "Unavailable" } }]);
    try { expect(await f.outcome).toHaveProperty("error.message", "Unavailable"); expect(f.counts()).toEqual({ creates: 1, polls: 1 }); }
    finally { f.cleanup(); }
  });
});
