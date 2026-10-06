import { describe, expect, it, vi } from "vitest";
import {
  claudeNeedsRefresh,
  parseClaudeOauthCredential,
  resolveClaudeAccessToken,
  storedClaudeCredential,
} from "../services/claude-oauth-credential.js";

const HOUR = 3600 * 1000;
const NOW = 1_800_000_000_000;
const credential = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: NOW + 8 * HOUR,
      scopes: ["user:inference"],
      ...over,
    },
  });
const noLock = async () => {
  throw new Error("lock not expected");
};
const lockOver = (state: { raw: string }) => async <T>(fn: (lock: { readRaw(): Promise<string>; writeRaw(v: string): Promise<unknown> }) => Promise<T>) =>
  fn({ readRaw: async () => state.raw, writeRaw: async (v) => { state.raw = v; } });
const okResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

describe("storedClaudeCredential", () => {
  it("keeps only OAuth fields", () => {
    const stored = JSON.parse(
      storedClaudeCredential({ accessToken: "a", refreshToken: "r", expiresAt: 5, scopes: ["x"], other: 1 })!,
    );
    expect(Object.keys(stored.claudeAiOauth).sort()).toEqual(["accessToken", "expiresAt", "refreshToken", "scopes"]);
  });
  it("returns null without a refresh token or expiry", () => {
    expect(storedClaudeCredential({ accessToken: "a" })).toBeNull();
    expect(storedClaudeCredential({ accessToken: "a", refreshToken: "r" })).toBeNull();
  });
});

describe("resolveClaudeAccessToken", () => {
  it("passes a plain token through without a lock", async () => {
    expect(await resolveClaudeAccessToken("sk-ant-oat01-plain", { withLock: noLock, now: () => NOW })).toBe("sk-ant-oat01-plain");
    expect(parseClaudeOauthCredential("{not json")).toBeNull();
  });
  it("returns a fresh token without a lock or network call", async () => {
    expect(await resolveClaudeAccessToken(credential(), { withLock: noLock, now: () => NOW })).toBe("at-1");
  });
  it("does not refresh when there is no refresh token", async () => {
    const raw = credential({ refreshToken: undefined, expiresAt: NOW - HOUR });
    expect(claudeNeedsRefresh(parseClaudeOauthCredential(raw)!, NOW)).toBe(false);
    expect(await resolveClaudeAccessToken(raw, { withLock: noLock, now: () => NOW })).toBe("at-1");
  });
  it("refreshes an expiring token and stores the rotated pair", async () => {
    const state = { raw: credential({ expiresAt: NOW + HOUR / 2 }) };
    const fetchImpl = vi.fn(async () => okResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 28800 }));
    const token = await resolveClaudeAccessToken(state.raw, { withLock: lockOver(state), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });
    expect(token).toBe("at-2");
    const saved = JSON.parse(state.raw).claudeAiOauth;
    expect(saved).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2", expiresAt: NOW + 28800 * 1000 });
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
    });
  });
  it("uses a token another run already renewed", async () => {
    const stale = credential({ expiresAt: NOW });
    const state = { raw: credential({ accessToken: "at-9" }) };
    const fetchImpl = vi.fn();
    expect(await resolveClaudeAccessToken(stale, { withLock: lockOver(state), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW })).toBe("at-9");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("falls back to a still-valid token on a transient failure", async () => {
    const state = { raw: credential({ expiresAt: NOW + HOUR / 2 }) };
    const fetchImpl = vi.fn(async () => okResponse({}, 503));
    expect(await resolveClaudeAccessToken(state.raw, { withLock: lockOver(state), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW })).toBe("at-1");
  });
  it("fails with a rejected error when the provider refuses the refresh token", async () => {
    const state = { raw: credential({ expiresAt: NOW + HOUR / 2 }) };
    const fetchImpl = vi.fn(async () => okResponse({ error: "invalid_grant" }, 400));
    await expect(
      resolveClaudeAccessToken(state.raw, { withLock: lockOver(state), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW }),
    ).rejects.toMatchObject({ name: "ClaudeOauthRefreshError", rejected: true });
  });
});
