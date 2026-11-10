import { describe, expect, it } from "vitest";
import { gradeIntegratorCases, integratorCasesCases } from "./integrator-cases.js";
function valid(id: string) {
  const disabled = id === "cases.cases-disabled";
  const openCases = [{ id: "open", identifier: "ACORN-C-1", title: "Mobile checkout failure", status: "in_progress", projectId: "launch" }, { id: "review", identifier: "ACORN-C-2", title: "Keyboard focus loss", status: "in_review", projectId: "launch" }];
  const excludedCases = [{ id: "closed", identifier: "ACORN-C-3", title: "Resolved clipping", status: "done", projectId: "launch" }, { id: "other", identifier: "ACORN-C-4", title: "Research bug", status: "in_progress", projectId: "research" }];
  return { scenarioId: id, origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { openCases: structuredClone(openCases), excludedCases, finishedTask: { id: "finished" } },
    tasks: disabled ? [] : [{ id: "finished", status: "done" }], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [], runs: [{ id: "run", agentId: "ceo", status: "succeeded" }],
    casesEnabled: !disabled, casesReadStatus: disabled ? 403 : 200, casesReadError: disabled ? "Cases are disabled" : undefined, cases: disabled ? [] : [...openCases, ...excludedCases], links: disabled ? [] : ["/ACORN/cases/ACORN-C-1", "/ACORN/cases/review"],
    reply: disabled ? "Cases is unavailable in this instance. Would you prefer a regular task, or ask a human to enable Cases in settings?" : "Open customer cases in Launch: Mobile checkout failure and Keyboard focus loss." };
}
describe("case browsing and disabled feature controls", () => {
  for (const definition of integratorCasesCases) it(`${definition.scenarioId}: valid public shape and missing evidence`, () => {
    expect(gradeIntegratorCases(valid(definition.scenarioId)).passed).toBe(true);
    expect(gradeIntegratorCases(undefined).passed).toBe(false);
    expect(gradeIntegratorCases({ ...valid(definition.scenarioId), casesReadStatus: undefined }).passed).toBe(false);
  });
  it("rejects task-done means case-closed, cross-project results and false browser mutation", () => {
    const o = valid("cases.browse-cases");
    const collision = structuredClone(o); collision.state.openCases[1]!.id = collision.state.openCases[0]!.id;
    expect(gradeIntegratorCases(collision).passed).toBe(false);
    const closed = structuredClone(o); closed.cases[0]!.status = "done";
    expect(gradeIntegratorCases(closed).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, links: [...o.links, "/ACORN/cases/other"] }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, reply: `${o.reply} I updated the columns.` }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, links: ["https://foreign.test/ACORN/cases/open", "/ACORN/cases/review"] }).passed).toBe(false);
  });
  it("rejects silently enabled Cases, a task called a case, and negated unavailable grounding", () => {
    const o = valid("cases.cases-disabled");
    expect(gradeIntegratorCases({ ...o, casesEnabled: true }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, casesReadStatus: 404 }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, casesReadError: "Forbidden" }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, reply: "", interactions: [{ kind: "ask_user_questions", status: "pending", title: "Cases is unavailable", payload: { prompt: "Would you prefer a regular task or enable Cases in settings?" } }] }).passed).toBe(true);
    expect(gradeIntegratorCases({ ...o, reply: "", interactions: [{ kind: "ask_user_questions", status: "pending", title: "Customer bug details", payload: { prompt: "What is the bug and customer?" } }] }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, tasks: [{ id: "task", status: "backlog" }], reply: "Cases is unavailable, so I created a customer case as a normal task. Would you prefer settings?" }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, reply: "Cases is enabled and available. Would you prefer a regular task?" }).passed).toBe(false);
  });
});

it("retains four cases through the real API's company/type/key upsert semantics", async () => {
  const records = new Map<string, Record<string, unknown>>(); let index = 0;
  const api = {
    get: async (path: string) => path.includes("/cases?") ? [...records.values()] : { enableCases: false },
    patch: async () => ({}),
    post: async (path: string, body: Record<string, unknown>) => {
      if (path.endsWith("/cases")) {
        const key = String(body.key ?? "<null>"); const existing = records.get(key);
        const row = { ...body, id: existing?.id ?? `case-${++index}` }; records.set(key, row); return row;
      }
      return { ...body, id: `fixture-${++index}` };
    },
  };
  const context = { input: { nonce: "offline", api, fixtures: { company: { id: "company" } } } } as unknown as Parameters<typeof integratorCasesCases[0]["setup"]>[0];
  const definition = integratorCasesCases.find(row => row.scenarioId === "cases.browse-cases")!;
  const state = await definition.setup(context);
  expect(records.size).toBe(4);
  expect(new Set([...state.openCases as Array<{ id: string }>, ...state.excludedCases as Array<{ id: string }>].map(row => row.id)).size).toBe(4);
  expect([...records.keys()].every(key => key !== "<null>")).toBe(true);
  await definition.cleanup!(context, state);
});
