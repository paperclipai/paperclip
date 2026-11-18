// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Company, Project } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { markCachedSession } from "@/lib/cached-session";
import { startPersistedQueryCache } from "@/lib/persisted-query-cache";
import { useCompanyOrder } from "./useCompanyOrder";
import { useProjectOrder } from "./useProjectOrder";

const getSession = vi.hoisted(() => vi.fn());
const sidebarApi = vi.hoisted(() => ({
  getCompanyOrder: vi.fn(),
  updateCompanyOrder: vi.fn(),
  getProjectOrder: vi.fn(),
  updateProjectOrder: vi.fn(),
}));
vi.mock("@/api/auth", () => ({ authApi: { getSession } }));
vi.mock("../api/sidebarPreferences", () => ({ sidebarPreferencesApi: sidebarApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companies = [{ id: "company-1" }, { id: "company-2" }] as Company[];
const projects = [{ id: "project-1" }, { id: "project-2" }] as Project[];
let persistOrder: (ids: string[]) => void;

function CompanyHarness() {
  persistOrder = useCompanyOrder({ companies, userId: "user-1" }).persistOrder;
  return null;
}

function ProjectHarness() {
  persistOrder = useProjectOrder({ projects, companyId: "company-1", userId: "user-1" }).persistOrder;
  return null;
}

const cases = [
  { name: "company", Harness: CompanyHarness, ids: ["company-2", "company-1"], update: sidebarApi.updateCompanyOrder,
    key: queryKeys.sidebarPreferences.companyOrder("user-1") },
  { name: "project", Harness: ProjectHarness, ids: ["project-2", "project-1"], update: sidebarApi.updateProjectOrder,
    key: queryKeys.sidebarPreferences.projectOrder("company-1", "user-1") },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  for (const fn of Object.values(sidebarApi)) fn.mockReset();
  sidebarApi.getCompanyOrder.mockResolvedValue({ orderedIds: [], updatedAt: null });
  sidebarApi.getProjectOrder.mockResolvedValue({ orderedIds: [], updatedAt: null });
  sidebarApi.updateCompanyOrder.mockImplementation(async (data: { orderedIds: string[] }) => ({ ...data, updatedAt: null }));
  sidebarApi.updateProjectOrder.mockImplementation(async (_companyId: string, data: { orderedIds: string[] }) => ({ ...data, updatedAt: null }));
  getSession.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it.each(cases.flatMap(entry => ["user-1", "user-2"].map(verifiedUser => ({ ...entry, verifiedUser }))))(
  "holds a restored $name order until the session is verified ($verifiedUser)",
  async ({ Harness, ids, update, key, verifiedUser }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    const cache = startPersistedQueryCache(client, { storage: null, buildId: "test", eventTarget: null });
    markCachedSession(client);
    let complete!: (value: unknown) => void;
    getSession.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
      await act(async () => {});
      const before = client.getQueryData(key);

      await act(async () => persistOrder(ids));
      await act(async () => {});
      expect(getSession).toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(client.getQueryData(key)).toEqual(before);

      await act(async () => { complete({ user: { id: verifiedUser } }); });
      await act(async () => {});
      await act(async () => {});

      if (verifiedUser === "user-1") {
        expect(update).toHaveBeenCalledTimes(1);
        expect(update.mock.calls[0].at(-1)).toEqual({ orderedIds: ids });
        expect(client.getQueryData<{ orderedIds: string[] }>(key)?.orderedIds).toEqual(ids);
      } else {
        expect(update).not.toHaveBeenCalled();
        expect(client.getQueryData<{ orderedIds?: string[] }>(key)?.orderedIds ?? []).not.toEqual(ids);
      }
    } finally {
      cache.dispose();
      client.clear();
    }
  },
);
