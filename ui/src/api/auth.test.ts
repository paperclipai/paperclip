import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";
import { authApi } from "./auth";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("authApi.getSession", () => {
  it("keeps a valid session when optional bootstrap is malformed or belongs to another account", async () => {
    const session = { session: { id: "session", userId: "one" },
      user: { id: "one", email: "one@example.com", name: "One", image: null }, sentryDsn: null };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ...session, boardBootstrap: {
      userId: "two", companies: [], boardAccess: { userId: "two", isInstanceAdmin: true, companyIds: ["foreign"] },
    } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await authApi.getSession()).toEqual(session);
    fetchMock.mockResolvedValue(Response.json({ ...session, boardBootstrap: { userId: "one", companies: "invalid" } }));
    expect(await authApi.getSession()).toEqual(session);
  });

  it("retains a same-account bootstrap alongside the ordinary session", async () => {
    const session = { session: { id: "session", userId: "one" },
      user: { id: "one", email: "one@example.com", name: "One", image: null }, sentryDsn: null };
    const boardBootstrap = { userId: "one", companies: [], boardAccess: { userId: "one", isInstanceAdmin: false, companyIds: [] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...session, boardBootstrap })));
    expect(await authApi.getSession()).toEqual({ ...session, boardBootstrap });
  });

  it("returns null for an ordinary local 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.getSession()).resolves.toBeNull();
  });

  it("initiates recovery and stays pending for a Cloud tenant-session 401", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = authApi.getSession();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});

describe("authApi.signOut", () => {
  it("returns the managed deployment redirect from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, redirectTo: "/cloud/logout" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.signOut()).resolves.toEqual({
      success: true,
      redirectTo: "/cloud/logout",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });
});
