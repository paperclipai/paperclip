import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";
import { api, detachInflightGet } from "./client";
import { toolsApi } from "./tools";
import { museInvitationsApi } from "./museInvitations";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errorResponse(body: unknown, status = 401) {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tenant-session recovery", () => {
  it("loads anonymous Dot consent despite concurrent protected background probes", async () => {
    const reload = vi.fn();
    const requestId = `pcmcp_request_${"a".repeat(43)}`;
    const recovery = createTenantSessionRecoveryCoordinator(reload, () => `/dot-connect/${requestId}`);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    fetchMock.mockImplementation((url: string) => Promise.resolve(
      url.includes("/dot-mcp/requests/")
        ? jsonResponse({ id: requestId, agentConnection: true })
        : errorResponse({ error: "tenant_session_required" }),
    ));

    const background = api.get("/health");
    const consent = api.get(`/dot-mcp/requests/${requestId}`);
    await expect(background).rejects.toMatchObject({ status: 401 });
    await expect(consent).resolves.toEqual({ id: requestId, agentConnection: true });
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps concurrent failures pending and schedules one top-level reload", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    fetchMock.mockResolvedValue(errorResponse({ error: "tenant_session_required" }));

    const first = api.post("/tenant-session-a", { value: 1 });
    const second = api.post("/tenant-session-b", { value: 2 });

    await vi.waitFor(() => {
      expect(tenantSessionRecovery.recoverIfNeeded).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    let settled = false;
    void Promise.all([first, second]).then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("preserves ApiError handling for an unrelated 401", async () => {
    fetchMock.mockResolvedValue(errorResponse({ error: "unauthorized" }));

    await expect(api.get("/ordinary-401")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "unauthorized",
    });

    fetchMock.mockResolvedValue(jsonResponse({ recovered: true }));
    await expect(api.get("/ordinary-401")).resolves.toEqual({ recovered: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("in-tab GET coalescing", () => {
  it("shares one underlying fetch for identical in-flight GETs", async () => {
    const d = deferred<Response>();
    fetchMock.mockReturnValue(d.promise);

    const p1 = api.get("/coalesce-a");
    const p2 = api.get("/coalesce-a");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    d.resolve(jsonResponse({ value: 1 }));
    expect(await p1).toEqual({ value: 1 });
    expect(await p2).toEqual({ value: 1 });
  });

  it("issues a fresh fetch after the previous one settles", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ value: "x" }));
    await api.get("/coalesce-b");
    await api.get("/coalesce-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce different paths", async () => {
    fetchMock.mockReturnValue(deferred<Response>().promise);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = api.get("/path-1", { signal: c1.signal });
    const p2 = api.get("/path-2", { signal: c2.signal });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Clean up the never-settling shared entries so the module map does not leak.
    c1.abort();
    c2.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops later callers joining a detached in-flight GET", async () => {
    // A GET issued under one account's session must not answer a caller that
    // runs after the account changed.
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise);
    const previousAccount = api.get("/detach-me");

    detachInflightGet("/detach-me");

    const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(second.promise);
    const currentAccount = api.get("/detach-me");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Each caller gets its own response, not the other's.
    first.resolve(jsonResponse({ companies: ["previous"] }));
    second.resolve(jsonResponse({ companies: ["current"] }));
    expect(await previousAccount).toEqual({ companies: ["previous"] });
    expect(await currentAccount).toEqual({ companies: ["current"] });
  });

  it("never coalesces mutations", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await Promise.all([api.post("/mutate", { a: 1 }), api.post("/mutate", { a: 1 })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("issue-list request scheduling", () => {
  it("starts at most three distinct issue lists at once and drains the queue", async () => {
    const responses = Array.from({ length: 7 }, () => deferred<Response>());
    fetchMock.mockImplementation(() => responses[fetchMock.mock.calls.length - 1]!.promise);

    const requests = Array.from({ length: 7 }, (_, index) =>
      api.get(`/companies/company-1/issues?status=status-${index}`),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);

    responses[0]!.resolve(jsonResponse(["first"]));
    await expect(requests[0]).resolves.toEqual(["first"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    for (const response of responses.slice(1)) response.resolve(jsonResponse([]));
    await expect(Promise.all(requests.slice(1))).resolves.toEqual(
      Array.from({ length: 6 }, () => []),
    );
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("drops an aborted queued issue list before it reaches fetch", async () => {
    const active = Array.from({ length: 3 }, () => deferred<Response>());
    fetchMock.mockImplementation(() => active[fetchMock.mock.calls.length - 1]!.promise);
    const requests = active.map((_, index) =>
      api.get(`/companies/company-1/issues?status=active-${index}`),
    );
    const controller = new AbortController();
    const queued = api.get("/companies/company-1/issues?status=queued", {
      signal: controller.signal,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    active.forEach((response) => response.resolve(jsonResponse([])));
    await Promise.all(requests);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a shared queued issue list when one caller aborts", async () => {
    const active = Array.from({ length: 3 }, () => deferred<Response>());
    const sharedResponse = deferred<Response>();
    fetchMock.mockImplementation(() => {
      const index = fetchMock.mock.calls.length - 1;
      return index < active.length ? active[index]!.promise : sharedResponse.promise;
    });
    const blockers = active.map((_, index) =>
      api.get(`/companies/company-1/issues?status=active-${index}`),
    );
    const firstController = new AbortController();
    const secondController = new AbortController();
    const path = "/companies/company-1/issues?status=shared";
    const first = api.get(path, { signal: firstController.signal });
    const second = api.get(path, { signal: secondController.signal });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    active[0]!.resolve(jsonResponse([]));
    await blockers[0];
    expect(fetchMock).toHaveBeenCalledTimes(4);
    sharedResponse.resolve(jsonResponse(["shared"]));
    await expect(second).resolves.toEqual(["shared"]);
    for (const response of active.slice(1)) response.resolve(jsonResponse([]));
    await Promise.all(blockers.slice(1));
  });

  it("allows a fresh caller after all queued callers abort", async () => {
    const active = Array.from({ length: 3 }, () => deferred<Response>());
    const freshResponse = deferred<Response>();
    fetchMock.mockImplementation(() => {
      const index = fetchMock.mock.calls.length - 1;
      return index < active.length ? active[index]!.promise : freshResponse.promise;
    });
    const blockers = active.map((_, index) =>
      api.get(`/companies/company-1/issues?status=active-${index}`),
    );
    const firstController = new AbortController();
    const secondController = new AbortController();
    const path = "/companies/company-1/issues?status=shared";
    const first = api.get(path, { signal: firstController.signal });
    const second = api.get(path, { signal: secondController.signal });
    firstController.abort();
    secondController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const fresh = api.get(path);
    active[0]!.resolve(jsonResponse([]));
    await blockers[0];
    expect(fetchMock).toHaveBeenCalledTimes(4);
    freshResponse.resolve(jsonResponse(["fresh"]));
    await expect(fresh).resolves.toEqual(["fresh"]);
    for (const response of active.slice(1)) response.resolve(jsonResponse([]));
    await Promise.all(blockers.slice(1));
  });
});

describe("per-caller abort semantics", () => {
  it("aborting one caller rejects only that caller, not the shared fetch", async () => {
    const d = deferred<Response>();
    let sharedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      sharedSignal = init.signal ?? undefined;
      return d.promise;
    });

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = api.get("/abort-a", { signal: c1.signal });
    const p2 = api.get("/abort-a", { signal: c2.signal });

    c1.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    // The shared fetch is still alive because caller 2 has not aborted.
    expect(sharedSignal?.aborted).toBe(false);

    d.resolve(jsonResponse({ value: 2 }));
    expect(await p2).toEqual({ value: 2 });
  });

  it("aborts the shared fetch after all callers cancel and permits a fresh request", async () => {
    const d = deferred<Response>();
    let sharedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      sharedSignal = init.signal ?? undefined;
      return d.promise;
    });

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = api.get("/abort-b", { signal: c1.signal });
    const p2 = api.get("/abort-b", { signal: c2.signal });

    c1.abort();
    c2.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({ value: "fresh" }));
    const fresh = api.get("/abort-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await fresh).toEqual({ value: "fresh" });
  });

  it("rejects immediately if the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(api.get("/already-aborted", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe("managed-account request isolation", () => {
  it("does not share a previous viewing user's pending account response", async () => {
    const previous = deferred<Response>();
    const current = deferred<Response>();
    fetchMock.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const previousUser = toolsApi.listAggregatorApps("shared-gateway");
    const currentUser = toolsApi.listAggregatorApps("shared-gateway");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, options]) => options.cache === "no-store")).toBe(true);
    current.resolve(jsonResponse({ apps: ["current-user-account"] }));
    previous.resolve(jsonResponse({ apps: ["previous-user-account"] }));
    expect(await currentUser).toEqual({ apps: ["current-user-account"] });
    expect(await previousUser).toEqual({ apps: ["previous-user-account"] });
  });
});

describe("Muse operator request isolation", () => {
  it.each([
    ["invitation resume", () => museInvitationsApi.resume("company")],
    ["connection evidence", () => museInvitationsApi.connection("company", "agent")],
  ] as const)("does not join the previous operator's %s request", async (_name, read) => {
    const previous = deferred<Response>();
    const current = deferred<Response>();
    fetchMock.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const previousOperator = read();
    const currentOperator = read();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, options]) => options.cache === "no-store")).toBe(true);
    current.resolve(jsonResponse({ operator: "current" }));
    previous.resolve(jsonResponse({ operator: "previous" }));
    expect(await currentOperator).toEqual({ operator: "current" });
    expect(await previousOperator).toEqual({ operator: "previous" });
  });
});
