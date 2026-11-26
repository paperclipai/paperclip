import { beforeEach, expect, it, vi } from "vitest";

// Cases that read links from the rendered reply must wait for the saved reply
// to render first: run settle precedes the render, and reading the DOM
// immediately captured no links although the reply contained the right one.
const calls: string[] = [];
const waits: Array<{ leadId: string; runs: Array<{ id: string }> }> = [];
vi.mock("./internal-comment-reference.js", async original => ({
  ...await original<typeof import("./internal-comment-reference.js")>(),
  waitForRenderedReply: vi.fn(async (_ctx: unknown, o: { leadId: string; runs: Array<{ id: string }> }) => {
    calls.push("wait"); waits.push(o); throw new Error("stopped after the rendered reply wait");
  }),
}));
const { runtimeHandoffCases } = await import("./runtime-handoffs.js");
const { profileIdentityCases } = await import("./identity-profile.js");

beforeEach(() => { calls.length = 0; waits.length = 0; });
function context(runs: Array<Record<string, unknown>>, comments: Array<Record<string, unknown>> = []) {
  const locator = () => { calls.push("dom-read"); throw new Error("rendered DOM read before the reply wait"); };
  return {
    input: { fixtures: { agent: { id: "ceo" }, company: { id: "company", issuePrefix: "COM" } }, execution: { id: "unit" },
      page: { locator, url: () => "http://fixture.invalid/COM/issues/COM-1" },
      api: { get: async (path: string) => { calls.push(`api:${path}`); return path.includes("/comments") ? comments : { user: { name: "Alex Former" } }; } } },
    refreshIssue: async () => {}, issue: () => ({ id: "source", conversationState: "waiting" }), allRuns: async () => runs,
  } as never;
}

it("track-delegated-work waits for the query replies to render before reading their links", async () => {
  const delegated = runtimeHandoffCases.find(row => row.scenarioId === "agent-chat.track-delegated-work")!;
  const runs = [{ id: "handoff", agentId: "ceo", status: "succeeded" }, { id: "worker", agentId: "morgan", status: "running" }, { id: "query", agentId: "ceo", status: "succeeded" }];
  const ctx = context(runs, [{ id: "reply", authorAgentId: "ceo", createdByRunId: "query", body: "[Website](/COM/issues/COM-2)" }]);
  await expect(delegated.act!(ctx, { setupRunIds: ["handoff", "worker"], workerRunId: "worker", sourceId: "source" })).rejects.toThrow("stopped after the rendered reply wait");
  expect(calls.filter(call => !call.startsWith("api:"))).toEqual(["wait"]);
  expect(waits[0]).toMatchObject({ leadId: "ceo", runs: [{ id: "query" }] });
});

it("edit-profile waits for the reply to render before looking for the profile link", async () => {
  const ctx = context([{ id: "reply-run", agentId: "ceo", status: "succeeded" }]);
  await expect(profileIdentityCases[0]!.act!(ctx, {})).rejects.toThrow("stopped after the rendered reply wait");
  expect(calls).toEqual(["wait"]);
  expect(waits[0]).toMatchObject({ leadId: "ceo", runs: [{ id: "reply-run" }] });
});
