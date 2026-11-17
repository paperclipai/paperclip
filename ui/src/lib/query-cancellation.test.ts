import { CancelledError } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { startPersistedQueryCache } from "./persisted-query-cache";
import { createAppQueryClient } from "./query-client";
import { queryKeys } from "./queryKeys";

vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn() } }));

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const reportError = vi.fn<(error: unknown) => void>();
const handles: Array<() => void> = [];
const pending = () => new Promise<never>(() => {});

function setup() {
  const client = createAppQueryClient({ reportError,
    connectivity: { reportError: () => {}, getSnapshot: () => ({ status: "online" }) as never } },
  { defaultOptions: { queries: { retry: false } } });
  const handle = startPersistedQueryCache(client, { storage: new MemoryStorage(), buildId: "build-one", eventTarget: null, debounceMs: 100_000 });
  handles.push(() => { handle.dispose(); client.clear(); });
  client.setQueryData(queryKeys.auth.session, { session: { id: "session-alice", userId: "alice" }, user: { id: "alice" } });
  client.setQueryData(queryKeys.companies.list("alice"), { companies: [{ id: "company-one", name: "Example" }], unauthorized: false });
  client.setQueryData([...queryKeys.access.currentBoardAccess, "alice"], { userId: "alice", companyIds: ["company-one"], isInstanceAdmin: false });
  return client;
}
afterEach(() => { for (const dispose of handles.splice(0)) dispose(); vi.clearAllMocks(); });

describe("persisted cache cancellation", () => {
  it("is not reported when a session denial clears an in-flight read", async () => {
    const client = setup();
    const inFlight = client.fetchQuery({ queryKey: queryKeys.agents.list("company-one"), queryFn: pending });
    await client.fetchQuery({ queryKey: queryKeys.auth.session, staleTime: 0,
      queryFn: async () => { throw new ApiError("Unauthorized", 401, null); } }).catch(() => {});
    await expect(inFlight).rejects.toBeInstanceOf(CancelledError);
    expect(client.getQueryCache().find({ queryKey: queryKeys.agents.list("company-one") })).toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not replace a task denial on an alias whose read was still in flight", async () => {
    const client = setup();
    const alias = queryKeys.issues.detail("task-one");
    client.setQueryData(alias, { id: "task-one", identifier: "TST-1", companyId: "company-one", title: "Denied task body" });
    const inFlight = client.fetchQuery({ queryKey: alias, staleTime: 0, queryFn: pending });
    const denial = new ApiError("Forbidden", 403, null);
    await client.fetchQuery({ queryKey: [...alias, "core"], staleTime: 0, queryFn: async () => { throw denial; } }).catch(() => {});
    await inFlight.catch(() => {});
    expect(client.getQueryState(alias)).toMatchObject({ status: "error", fetchStatus: "idle", error: denial, data: undefined });
    expect(reportError).not.toHaveBeenCalled();
  });
});
