// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingCloudHandoff,
  OAuthHandoffError,
  prepareOAuthNavigation,
  readPendingCloudHandoff,
  savePendingCloudHandoff,
} from "./oauthHandoff";

const SESSION = "cloud_session_abcdefghijklmnop";

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("Paperclip Cloud OAuth handoff", () => {
  it("uses the fixed same-origin endpoint and never navigates to the legacy confirmation URL", async () => {
    const request = vi.fn(async () => Response.json({
      authorizationUrl: "https://provider.example.test/authorize?state=one",
    }));

    const target = await prepareOAuthNavigation({
      authorizationUrl: "https://my.example.test/connections/confirm?session=legacy",
      handoff: { kind: "paperclip_cloud", session: SESSION },
    }, { request: request as typeof fetch });

    expect(request).toHaveBeenCalledWith("/cloud/connections/handoff", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ session: SESSION }),
    }));
    expect(target).toMatchObject({ kind: "authorization", host: "provider.example.test" });
    expect(target.url).not.toContain("/connections/confirm");
  });

  it("retries one transient failure with the identical opaque session", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ authorizationUrl: "https://provider.example.test/authorize" }));

    await prepareOAuthNavigation({
      authorizationUrl: "https://my.example.test/connections/confirm",
      handoff: { kind: "paperclip_cloud", session: SESSION },
    }, { request });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]?.body).toBe(request.mock.calls[1]?.[1]?.body);
  });

  it("accepts only the fixed same-origin reauthentication route", async () => {
    const request = vi.fn(async () => Response.json({
      error: "RECENT_LOGIN_REQUIRED",
      reauthenticationUrl: `${window.location.origin}/cloud/connections/reauth?session=${SESSION}`,
    }, { status: 401 }));

    await expect(prepareOAuthNavigation({
      authorizationUrl: "https://my.example.test/connections/confirm",
      handoff: { kind: "paperclip_cloud", session: SESSION },
    }, { request: request as typeof fetch })).resolves.toMatchObject({ kind: "reauthentication" });

    request.mockResolvedValueOnce(Response.json({
      error: "RECENT_LOGIN_REQUIRED",
      reauthenticationUrl: `https://evil.example/cloud/connections/reauth?session=${SESSION}`,
    }, { status: 401 }));
    await expect(prepareOAuthNavigation({
      authorizationUrl: "https://my.example.test/connections/confirm",
      handoff: { kind: "paperclip_cloud", session: SESSION },
    }, { request: request as typeof fetch })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects malformed descriptors without making a request", async () => {
    const request = vi.fn();
    await expect(prepareOAuthNavigation({
      authorizationUrl: "https://provider.example.test/authorize",
      handoff: { kind: "paperclip_cloud", session: "bad session" },
    }, { request: request as typeof fetch })).rejects.toBeInstanceOf(OAuthHandoffError);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the opaque handoff in per-tab storage for reauthentication resume", () => {
    savePendingCloudHandoff(SESSION);
    expect(readPendingCloudHandoff()).toEqual({ kind: "paperclip_cloud", session: SESSION });
    clearPendingCloudHandoff();
    expect(readPendingCloudHandoff()).toBeNull();
  });

  it("keeps direct and legacy OAuth on the validated authorization URL", async () => {
    await expect(prepareOAuthNavigation({
      authorizationUrl: "https://provider.example.test/authorize",
    })).resolves.toMatchObject({ kind: "authorization", host: "provider.example.test" });
  });
});
