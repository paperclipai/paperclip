import { describe, expect, it, vi } from "vitest";
import { GoogleWorkspaceAuthError } from "./errors.js";
import { probeGoogleWorkspaceRestService } from "./probe.js";

describe("probeGoogleWorkspaceRestService", () => {
  it("reads the Gmail profile once with the caller's token", async () => {
    const fetch = vi.fn(async () => Response.json({ emailAddress: "someone@example.test", messagesTotal: 1 }));
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "token-1", fetch })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer token-1");
  });

  it("reads one Calendar list entry for Calendar", async () => {
    const fetch = vi.fn(async () => Response.json({ items: [{ id: "primary" }] }));
    await expect(probeGoogleWorkspaceRestService({ service: "calendar", accessToken: "token-1", fetch })).resolves.toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/calendar/v3/users/me/calendarList");
    expect(new URL(url).searchParams.get("maxResults")).toBe("1");
    expect(init.method).toBe("GET");
  });

  it("throws token problems so the caller can refresh or ask for reconnection", async () => {
    const unauthenticated = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "t", fetch: unauthenticated }))
      .rejects.toMatchObject({ reason: "unauthenticated" });
    const narrow = vi.fn(async () => Response.json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, { status: 403 }));
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "t", fetch: narrow }))
      .rejects.toBeInstanceOf(GoogleWorkspaceAuthError);
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "", fetch: unauthenticated }))
      .rejects.toMatchObject({ reason: "unauthenticated" });
  });

  it("reports any other Google failure as an unavailable service", async () => {
    const disabled = vi.fn(async () => Response.json({ error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } }, { status: 403 }));
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "t", fetch: disabled }))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining("not enabled") });
  });
});
