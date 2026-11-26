import { expect, it, vi } from "vitest";
import { readClarificationState } from "./clarification-flow.js";
import type { JourneyContext } from "./types.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const parent = { id: issueId, companyId, parentId: null, assigneeAgentId: "agent", status: "in_progress" };
const child = { id: "child", companyId, parentId: issueId };
function fixture(rows = [parent, child]) {
  const get = vi.fn(async (route: string) => {
    const url = new URL(route, "https://qa.example.test");
    if (url.pathname === `/api/companies/${companyId}/issues`) {
      if (url.searchParams.get("view") !== "index") throw Error("unsupported child projection");
      return rows.filter(row => row.parentId === url.searchParams.get("parentIds"));
    }
    if (url.pathname === `/api/issues/${issueId}`) return parent;
    return [];
  });
  const context = { company: { id: companyId }, environmentId: "daytona", api: { get },
    agent: { id: "agent", provider: "opencode", model: "model", runtimeMode: "native" } } as unknown as JourneyContext;
  return { context, get };
}
it("reads the supported child projection while excluding the journey task and unrelated company work", async () => {
  const { context, get } = fixture([parent, child, { id: "unrelated", companyId, parentId: "other" }]);
  expect((await readClarificationState(context, issueId)).children).toEqual([child]);
  expect(get).toHaveBeenCalledWith(`/api/companies/${companyId}/issues?view=index&parentIds=${issueId}&limit=2`);
});
it("retains an empty child result for a task that did not delegate work", async () => {
  expect((await readClarificationState(fixture([parent]).context, issueId)).children).toEqual([]);
});
it.each([{ ...child, companyId: "other" }, { ...child, parentId: "other" }])("rejects a returned child outside the owned company or task", async foreign => {
  const { context, get } = fixture();
  get.mockImplementation(async route => route.includes("/companies/") ? [foreign] : route === `/api/issues/${issueId}` ? parent : []);
  await expect(readClarificationState(context, issueId)).rejects.toMatchObject({ code: "clarification_child_query_mismatch" });
});
