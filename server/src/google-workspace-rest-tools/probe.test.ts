import { describe, expect, it, vi } from "vitest";
import { googleWorkspaceRestProbeFor, probeGoogleWorkspaceRestService } from "./probe.js";

const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const GMAIL_READ = scope("gmail.readonly");

describe("probeGoogleWorkspaceRestService", () => {
  it("reads the Gmail profile once with the caller's token", async () => {
    const fetch = vi.fn(async () => Response.json({ emailAddress: "someone@example.test", messagesTotal: 1 }));
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "token-1", grantedScopes: [GMAIL_READ], fetch })).resolves.toEqual({ ok: true, probed: true });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer token-1");
  });

  it("reads one Calendar list entry for Calendar", async () => {
    const fetch = vi.fn(async () => Response.json({ items: [{ id: "primary" }] }));
    await expect(probeGoogleWorkspaceRestService({ service: "calendar", accessToken: "token-1", grantedScopes: [scope("calendar.calendarlist.readonly")], fetch })).resolves.toEqual({ ok: true, probed: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/calendar/v3/users/me/calendarList");
    expect(new URL(url).searchParams.get("maxResults")).toBe("1");
    expect(init.method).toBe("GET");
  });

  it("throws a rejected token, and never treats an insufficient-scope answer as a failed probe", async () => {
    const unauthenticated = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "t", grantedScopes: [GMAIL_READ], fetch: unauthenticated }))
      .rejects.toMatchObject({ reason: "unauthenticated" });
    const narrow = vi.fn(async () => Response.json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, { status: 403 }));
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "t", grantedScopes: [GMAIL_READ], fetch: narrow }))
      .resolves.toEqual({ ok: true, probed: true });
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "", grantedScopes: [GMAIL_READ], fetch: unauthenticated }))
      .rejects.toMatchObject({ reason: "unauthenticated" });
  });

  it("reports any other Google failure as an unavailable service", async () => {
    const disabled = vi.fn(async () => Response.json({ error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } }, { status: 403 }));
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "t", grantedScopes: [GMAIL_READ], fetch: disabled }))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining("not enabled") });
  });

  it("picks the first probe the granted scopes allow, and none when no read is granted", async () => {
    const path = (scopes: string[]) => {
      const candidate = googleWorkspaceRestProbeFor("calendar", scopes.map(scope));
      return candidate ? new URL(`https://x${candidate.request(0).path}`).pathname : null;
    };
    expect(path(["calendar.calendarlist.readonly", "calendar.events"])).toBe("/calendar/v3/users/me/calendarList");
    expect(path(["calendar.events"])).toBe("/calendar/v3/calendars/primary/events");
    expect(path(["calendar.events.readonly"])).toBe("/calendar/v3/calendars/primary/events");
    expect(path(["calendar.events.freebusy"])).toBe("/calendar/v3/freeBusy");
    expect(googleWorkspaceRestProbeFor("gmail", [scope("gmail.compose")])).toBeNull();
    const fetch = vi.fn();
    await expect(probeGoogleWorkspaceRestService({ service: "gmail", accessToken: "t", grantedScopes: [scope("gmail.compose")], fetch }))
      .resolves.toEqual({ ok: true, probed: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["docs", "slides"] as const)("lists %s without a network probe, since every read needs a file ID", async (service) => {
    const fetch = vi.fn();
    for (const scopes of [["documents.readonly", "documents"], ["presentations.readonly", "presentations"]]) {
      expect(googleWorkspaceRestProbeFor(service, scopes.map(scope))).toBeNull();
      await expect(probeGoogleWorkspaceRestService({ service, accessToken: "t", grantedScopes: scopes.map(scope), fetch }))
        .resolves.toEqual({ ok: true, probed: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
