import { expect, it, vi } from "vitest";
import { QueryClient, useQuery, useQueries } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { useProfileIndexData } from "./useProfilesData";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueries: vi.fn(),
  useQuery: vi.fn(),
}));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("@/api/tools", () => ({ toolsApi: { listProfileSummaries: vi.fn() } }));

it("loads the profile summaries and resolver agents without the editor's catalog queries", async () => {
  useProfileIndexData("company");
  expect(useQueries).not.toHaveBeenCalled();
  const queries = vi.mocked(useQuery).mock.calls.map(([options]) => options);
  expect(queries.map(query => query.queryKey)).toEqual([
    [...queryKeys.tools.profiles("company"), "summary"],
    queryKeys.agents.list("company"),
  ]);
  for (const query of queries) {
    const run = query.queryFn;
    if (typeof run === "function") {
      await run({} as Parameters<typeof run>[0]);
    }
  }
  expect(toolsApi.listProfileSummaries).toHaveBeenCalledExactlyOnceWith("company");
  expect(agentsApi.list).toHaveBeenCalledExactlyOnceWith("company");
});


it("invalidates the index summary with the existing company profile key", async () => {
  vi.mocked(useQuery).mockClear();
  useProfileIndexData("company");
  const summaryKey = vi.mocked(useQuery).mock.calls[0][0].queryKey;
  const profilesKey = queryKeys.tools.profiles("company");
  const client = new QueryClient();
  client.setQueryData(summaryKey, { profiles: [] });
  client.setQueryData(profilesKey, { profiles: [] });

  await client.invalidateQueries({ queryKey: profilesKey });

  expect(client.getQueryState(summaryKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(profilesKey)?.isInvalidated).toBe(true);
});
