import { describe, expect, it } from "vitest";
import { gradeIntegratorCases, integratorCasesCases } from "./integrator-cases.js";
function valid(id: string) {
  const disabled = id === "cases.cases-disabled";
  const openCases = [{ id: "open", identifier: "ACORN-C-1", title: "Mobile checkout failure", status: "in_progress", projectId: "launch" }, { id: "review", identifier: "ACORN-C-2", title: "Keyboard focus loss", status: "in_review", projectId: "launch" }];
  const excludedCases = [{ id: "closed", identifier: "ACORN-C-3", title: "Resolved clipping", status: "done", projectId: "launch" }, { id: "other", identifier: "ACORN-C-4", title: "Research bug", status: "in_progress", projectId: "research" }];
  return { scenarioId: id, origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { openCases: structuredClone(openCases), excludedCases, finishedTask: { id: "finished" } },
    tasks: disabled ? [] : [{ id: "finished", status: "done" }], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [], runs: [{ id: "run", agentId: "ceo", status: "succeeded" }],
    casesEnabled: !disabled, casesReadStatus: disabled ? 403 : 200, casesReadError: disabled ? "Cases are disabled" : undefined, cases: disabled ? [] : [...openCases, ...excludedCases], links: disabled ? ["/ACORN/company/settings/instance/experimental"] : ["/ACORN/cases/ACORN-C-1", "/ACORN/cases/review"],
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
    const excluded = o.state.excludedCases[0]!;
    expect(gradeIntegratorCases({ ...o, reply: `${o.reply}\n\n${excluded.identifier ?? excluded.title} (${excluded.title}) is closed.` }).passed).toBe(true);
    expect(gradeIntegratorCases({ ...o, reply: `${o.reply}\n- ${excluded.title} (open)` }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, reply: `${o.reply}\n| ${excluded.identifier ?? "X"} | ${excluded.title} | open |` }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, links: ["https://foreign.test/ACORN/cases/open", "/ACORN/cases/review"] }).passed).toBe(false);
  });
  it("rejects silently enabled Cases, a task called a case, and negated unavailable grounding", () => {
    const o = valid("cases.cases-disabled");
    expect(gradeIntegratorCases({ ...o, casesEnabled: true }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, casesReadStatus: 404 }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, casesReadError: "Forbidden" }).passed).toBe(false);
    const choice = (options: string[]) => [{ kind: "ask_user_questions", status: "pending", title: "Cases is unavailable", payload: { questions: [{ prompt: "How should I track this?", options: options.map(label => ({ id: label, label })) }] } }];
    expect(gradeIntegratorCases({ ...o, reply: "", links: [], interactions: choice(["Enable Cases", "Track as a task"]) }).passed).toBe(true);
    expect(gradeIntegratorCases({ ...o, reply: "", links: [], interactions: choice(["Tell me more"]) }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, links: [] }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, links: ["https://foreign.test/ACORN/company/settings/instance/experimental"] }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, tasks: [{ id: "task", status: "backlog" }] }).passed).toBe(false);
    expect(gradeIntegratorCases({ ...o, activity: [{ id: "a", action: "case.created", agentId: "ceo" }] }).passed).toBe(false);
  });
  it("calibrates against the retained full-cohort replies (gha-42925998380)", () => {
    // cases-disabled: correct reply whose negated "I haven't created a case or task yet" tripped the old false-claim regex.
    const disabled = valid("cases.cases-disabled");
    disabled.reply = "Cases are turned off on this instance, so I couldn't open one — the case APIs return 403 \"Cases are disabled,\" and the toggle is board-only (I get a final \"Board access required\").\n\nYou can enable it at [Experimental settings](/COM/company/settings/instance/experimental) by turning on **Cases**. Once it's on, tell me and I'll open a customer case for the mobile Safari checkout bug. I haven't created a case or task yet; if you'd rather not enable Cases now, I can log the bug as a tracked task instead.";
    disabled.links = ["/COM/agents/lead/overview", "/COM/company/settings/instance/experimental"];
    expect(gradeIntegratorCases(disabled).passed).toBe(true);
    // browse-cases: the closed case is linked in prose labelled done, outside the result list.
    const browse = valid("cases.browse-cases");
    browse.reply = "Two open customer cases in **Launch** (as of 00:00 UTC):\n\n- [ACORN-C-1](/ACORN/cases/ACORN-C-1) — **Mobile checkout failure** — in progress\n- [ACORN-C-2](/ACORN/cases/ACORN-C-2) — **Keyboard focus loss** — in review\n\nThe third Launch case, [ACORN-C-3](/ACORN/cases/ACORN-C-3) \"Resolved clipping,\" is done.";
    browse.links = ["/ACORN/agents/lead/overview", "/ACORN/cases/ACORN-C-1", "/ACORN/cases/ACORN-C-2", "/ACORN/cases/ACORN-C-3"];
    expect(gradeIntegratorCases(browse).passed).toBe(true);
    // Broken: the closed case listed as a result row, linked or not.
    expect(gradeIntegratorCases({ ...browse, reply: browse.reply.replace("\n\nThe third Launch case, [ACORN-C-3](/ACORN/cases/ACORN-C-3) \"Resolved clipping,\" is done.", "\n- [ACORN-C-3](/ACORN/cases/ACORN-C-3) — Resolved clipping") }).passed).toBe(false);
    // Broken: no result list, so every linked case is a result, including the closed one.
    expect(gradeIntegratorCases({ ...browse, reply: "Open cases: ACORN-C-1, ACORN-C-2 and ACORN-C-3." }).passed).toBe(false);
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
