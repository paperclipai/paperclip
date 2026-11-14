import { QueryClient } from "@tanstack/react-query";
import type { BoardBootstrap } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardAccessQueryOptions } from "./board-access-query";
import { ApiError } from "./client";
import { queryKeys } from "../lib/queryKeys";

const readAccess = vi.hoisted(() => vi.fn());
vi.mock("./access", () => ({ accessApi: { getCurrentBoardAccess: readAccess } }));
afterEach(() => readAccess.mockReset());

const bootstrap = (userId: string): BoardBootstrap => ({
  userId, companies: [], boardAccess: { userId, isInstanceAdmin: false, companyIds: [`company-${userId}`] },
});

describe("account-scoped board bootstrap", () => {
  it("opens from the session snapshot and uses the ordinary reader after invalidation", async () => {
    const client = new QueryClient();
    const options = boardAccessQueryOptions("one", bootstrap("one"), Date.now(), vi.fn());
    expect(await client.fetchQuery({ ...options, staleTime: 30_000 })).toEqual(bootstrap("one").boardAccess);
    expect(readAccess).not.toHaveBeenCalled();
    await client.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    readAccess.mockResolvedValue({ userId: "one", isInstanceAdmin: false, companyIds: [] });
    expect(await client.fetchQuery(options)).toEqual({ userId: "one", isInstanceAdmin: false, companyIds: [] });
    expect(readAccess).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it("cannot reuse another account's bootstrap or cache entry", async () => {
    const client = new QueryClient();
    const first = boardAccessQueryOptions("one", bootstrap("one"), Date.now(), vi.fn());
    await client.fetchQuery({ ...first, staleTime: Infinity });
    const second = boardAccessQueryOptions("two", bootstrap("one"), Date.now(), vi.fn());
    expect(second.initialData).toBeUndefined();
    expect(second.queryKey).not.toEqual(first.queryKey);
    readAccess.mockResolvedValue({ userId: "two", isInstanceAdmin: false, companyIds: [] });
    expect(await client.fetchQuery(second)).toMatchObject({ userId: "two", companyIds: [] });
    client.clear();
  });

  it("refreshes identity instead of caching a response from a changed account", async () => {
    const changed = vi.fn();
    readAccess.mockResolvedValue({ userId: "two", isInstanceAdmin: true, companyIds: ["foreign"] });
    await expect(boardAccessQueryOptions("one", undefined, 0, changed).queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({ status: 401 });
    expect(changed).toHaveBeenCalledOnce();
  });

  it.each([401, 403, "success", "account-change"] as const)("ignores canceled %s responses before invoking callbacks", async outcome => {
    const changed = vi.fn(), denied = vi.fn(), verified = vi.fn();
    const controller = new AbortController();
    let resolveAccess!: (value: unknown) => void;
    let rejectAccess!: (error: unknown) => void;
    readAccess.mockReturnValue(new Promise((resolve, reject) => { resolveAccess = resolve; rejectAccess = reject; }));
    const options = boardAccessQueryOptions("one", undefined, 0, changed, denied, verified);
    const pending = options.queryFn({ signal: controller.signal });
    expect(readAccess).toHaveBeenCalledExactlyOnceWith(controller.signal);
    controller.abort();
    if (typeof outcome === "number") {
      const error = new ApiError("Access refused", outcome, null);
      rejectAccess(error);
      await expect(pending).rejects.toBe(error);
    } else {
      resolveAccess({ userId: outcome === "account-change" ? "two" : "one", isInstanceAdmin: true, companyIds: ["company"] });
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    }
    expect(changed).not.toHaveBeenCalled();
    expect(denied).not.toHaveBeenCalled();
    expect(verified).not.toHaveBeenCalled();
  });
});
