import { describe, it, expect } from "vitest";
import { startMockProvider } from "./mock-provider.js";

describe("mock-provider", () => {
  it("serves /me with the default account", async () => {
    const m = await startMockProvider();
    try {
      const r = await fetch(`${m.url}/me`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { id: string; name: string };
      expect(body.id).toBe("user-1");
      expect(body.name).toBe("Test User");
    } finally {
      await m.close();
    }
  });

  it("issues a token with refresh + access on grant_type=authorization_code", async () => {
    const m = await startMockProvider();
    try {
      const r = await fetch(`${m.url}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "x",
        }).toString(),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body.access_token).toMatch(/^access-/);
      expect(body.refresh_token).toMatch(/^refresh-/);
      expect(body.expires_in).toBe(3600);
    } finally {
      await m.close();
    }
  });

  it("counts refresh calls and supports per-test overrides on /token", async () => {
    const m = await startMockProvider();
    try {
      m.state.consecutiveRefreshFailures = 1;
      const failed = await fetch(`${m.url}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "r",
        }).toString(),
      });
      expect(failed.status).toBe(500);
      expect(m.state.refreshCallCount).toBe(1);

      const ok = await fetch(`${m.url}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "r",
        }).toString(),
      });
      expect(ok.status).toBe(200);
      expect(m.state.refreshCallCount).toBe(2);
    } finally {
      await m.close();
    }
  });

  it("respects revokeStatus override on /revoke", async () => {
    const m = await startMockProvider();
    try {
      m.state.revokeStatus = 500;
      const r = await fetch(`${m.url}/revoke`, { method: "POST" });
      expect(r.status).toBe(500);
      expect(m.state.revokeCallCount).toBe(1);
    } finally {
      await m.close();
    }
  });
});
