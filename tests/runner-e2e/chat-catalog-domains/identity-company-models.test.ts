import { describe, expect, it, vi } from "vitest";
import { companyModelIdentityCases, requestedAuxiliaryServiceModel, saveFastResponseModelBeforeTest } from "./identity-company-models.js";
import type { IdentityObservation } from "./identity-support.js";
vi.mock("./identity-support.js", async importOriginal => ({
  ...await importOriginal<typeof import("./identity-support.js")>(), probeAgentPermission: async () => 403,
}));
function valid(scenarioId: string): IdentityObservation {
  const model = scenarioId === "companies.configure-decision-model" ? "typesafe/jev-1.13" : requestedAuxiliaryServiceModel;
  const usage = { inputTokens: 17, outputTokens: 8, costStatus: "reported", costCents: "0.02" };
  const history = { id: "test", connectionId: "shared", model, actorType: "user", responsibleUserId: "alex", feature: "settings.test", finishedAt: "2026-10-26T12:00:00Z", status: "succeeded", ...usage };
  const o: IdentityObservation = { scenarioId, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], interactions: [], tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], activity: [], links: [], runs: [], humanQueries: [],
    reply: "Open Connections in Settings to configure and test the optional fast acknowledgement or classifier model. An acknowledgement is only a receipt, not task work.",
    state: { connection: { id: "shared", name: "Shared QA", grantId: "grant", companyId: "acorn", ownership: "shared", provider: "openrouter", method: "api_key", status: "connected" }, humanId: "alex",
      saved: { companyId: "acorn", enabled: true, connectionId: "shared", grantId: "grant", model }, modelBeforeTest: model, beforeEnabled: false, afterReplyEnabled: false, agentWriteStatus: 403, agentTestStatus: 403,
      persistedAfterReload: true, testHttpStatus: 200, visibleTestReceipt: true, history: [history], testCostEvents: 2 } };
  if (scenarioId.endsWith("configure-decision-model")) o.state.testResult = { status: "succeeded", invocationId: "test", answers: {}, usage };
  else if (scenarioId.endsWith("fast-responses")) o.state.testResult = { status: "succeeded", invocationId: "test", text: "I will check that for you.", durationMs: 140, usage };
  else o.state.testResult = { passed: true, samples: [
    { name: "Benign source code", expectedViolation: false, actualViolation: false, passed: true, invocationId: "benign", durationMs: 80, usage },
    { name: "Malicious instructions", expectedViolation: true, actualViolation: true, passed: true, invocationId: "malicious", durationMs: 90, usage },
  ] };
  return o;
}
describe("company model service configuration and actual tests", () => {
  it.each(["companies.configure-decision-model", "companies.prompt-injection-guard"])("actual %s initial native observation uses the remaining original case clock", async scenario => {
    vi.useFakeTimers(); vi.setSystemTime(50_000);
    try {
      const get = vi.fn(async () => { throw new Error("Reached actual human settings phase"); });
      const ctx = { observationDeadlineAt: 440_000, refreshIssue: async () => {},
        issue: () => ({ conversationState: Date.now() >= 210_000 ? "waiting" : "running" }),
        allRuns: async () => [{ status: Date.now() >= 210_000 ? "succeeded" : "running" }],
        input: { execution: { id: `chat-features.runner-opencode.local.${scenario}` },
          fixtures: { company: { id: "acorn" } }, page: { url: () => "https://fixture.test" }, api: { get } },
      };
      const d = companyModelIdentityCases.find(row => row.scenarioId === scenario)!;
      const pending = Promise.resolve(d.act!(ctx as never, {})).then(() => null, error => error as Error);
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(160_000);
      expect((await pending)?.message).toBe("Reached actual human settings phase");
      expect(get).toHaveBeenCalledOnce(); expect(ctx.observationDeadlineAt).toBe(440_000);
    } finally { vi.useRealTimers(); }
  });

  for (const d of companyModelIdentityCases) {
    it(`${d.scenarioId}: valid and missing public evidence`, () => { const o = valid(d.scenarioId); expect(d.grade(o), JSON.stringify(d.grade(o))).toMatchObject({ passed: true }); expect(d.grade(undefined).passed).toBe(false); });
    it(`${d.scenarioId}: wrong shared account or authority`, () => { const o = valid(d.scenarioId); (o.state.saved as { grantId: string }).grantId = "other-grant"; expect(d.grade(o).passed).toBe(false); const wrong = valid(d.scenarioId); wrong.state.agentWriteStatus = 200; expect(d.grade(wrong).passed).toBe(false); });
    it(`${d.scenarioId}: configuration without an actual result is insufficient`, () => { const o = valid(d.scenarioId); delete o.state.testResult; expect(d.grade(o).passed).toBe(false); });
  }
  it.each(["companies.prompt-injection-guard", "companies.fast-responses"])("%s rejects saved/default/changed/missing model evidence", id => {
    const definition = companyModelIdentityCases.find(row => row.scenarioId === id)!;
    for (const model of ["openai/gpt-oss-safeguard-20b", "openai/gpt-oss-120b", "openrouter/deepseek/deepseek-v4.1-flash-1017", "deepseek/another-model"]) {
      const wrong = valid(id); (wrong.state.saved as { model: string }).model = model; expect(definition.grade(wrong).passed).toBe(false);
      const earlier = valid(id); earlier.state.modelBeforeTest = model; expect(definition.grade(earlier).passed).toBe(false);
    }
    const absent = valid(id); delete absent.state.modelBeforeTest; expect(definition.grade(absent).passed).toBe(false);
  });
  it("rejects fast-service history from a different actual model despite requested saved config", () => {
    const definition = companyModelIdentityCases.find(row => row.scenarioId === "companies.fast-responses")!;
    const wrong = valid(definition.scenarioId); (wrong.state.history as Array<{ model: string }>)[0]!.model = "openai/gpt-oss-120b";
    expect(definition.grade(wrong).passed).toBe(false);
  });
  it.each(["companies.prompt-injection-guard", "companies.fast-responses"])("%s actual human act stops before test if saved model differs", async id => {
    const definition = companyModelIdentityCases.find(row => row.scenarioId === id)!;
    const fill = vi.fn(async () => {}), save = vi.fn(async () => {}), test = vi.fn(async () => {});
    const section = { getByLabel: () => ({ fill }), getByRole: (_role: string, options: { name: string }) => ({
      click: options.name.startsWith("Test") ? test : save, setChecked: async () => {},
    }) };
    const get = vi.fn(async () => ({ settings: { enabled: false, model: "openai/wrong-default" } }));
    const ctx = { refreshIssue: async () => {}, issue: () => ({ conversationState: "waiting" }), allRuns: async () => [{ id: "source", status: "succeeded" }],
      observationDeadlineAt: Date.now() + 390_000, input: { fixtures: { company: { id: "acorn", issuePrefix: "RUN" } }, api: { get }, page: { waitForResponse: async () => ({ status: () => 200, json: async () => ({ model: "wrong" }) }), url: () => "https://fixture.test", goto: async () => {}, getByRole: () => section } } };
    await expect(definition.act!(ctx as never, valid(id).state)).rejects.toThrow(/Requested auxiliary model saved before any service test/);
    expect(fill).toHaveBeenCalledExactlyOnceWith(requestedAuxiliaryServiceModel); expect(save).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(id.endsWith("fast-responses") ? 1 : 2); expect(test).not.toHaveBeenCalled();
  });
  it("rejects an ordinary agent run standing in for a decision invocation", () => { const d = companyModelIdentityCases[0]!; const o = valid(d.scenarioId); o.runs = [{ id: "test", companyId: "acorn", agentId: "ceo", status: "succeeded" }]; o.state.history = []; expect(d.grade(o).passed).toBe(false); });
  it("rejects builtin fallback being reported as model classification", () => { const d = companyModelIdentityCases[1]!; const o = valid(d.scenarioId); (o.state.testResult as { samples: Array<{ invocationId?: string }> }).samples[0]!.invocationId = undefined; expect(d.grade(o).passed).toBe(false); });
  it("rejects classifier model samples without their independent cost events", () => { const d = companyModelIdentityCases[1]!; const o = valid(d.scenarioId); o.state.testCostEvents = 0; expect(d.grade(o).passed).toBe(false); });
  it("does not accept an instruction-only acknowledgement change as Fast response configuration guidance", () => {
    const d = companyModelIdentityCases.find(row => row.scenarioId === "companies.fast-responses")!;
    const o = valid(d.scenarioId);
    o.reply = "I updated my persistent instructions to acknowledge chat requests immediately.";
    const grade = d.grade(o);
    expect(grade.passed).toBe(false);
    expect(grade.checks.find(check => check.id === "honest-human-settings-guidance")?.passed).toBe(false);
  });
  it("rejects fast response work-completion claims", () => { const d = companyModelIdentityCases[2]!; const o = valid(d.scenarioId); o.reply = "Open Settings for fast responses. Your task is finished."; expect(d.grade(o).passed).toBe(false); });
  it("rejects an acknowledgement whose independent invocation belongs to a different human", () => { const d = companyModelIdentityCases[2]!; const o = valid(d.scenarioId); (o.state.history as Array<{ responsibleUserId: string }>)[0]!.responsibleUserId = "other-person"; expect(d.grade(o).passed).toBe(false); });
});

describe("fast settings save completion before any service invocation", () => {
  function fixture() {
    const saved = { companyId: "acorn", enabled: true, connectionId: "shared", grantId: "grant", model: requestedAuxiliaryServiceModel };
    let resolve!: (value: unknown) => void;
    const pending = new Promise(resolveValue => { resolve = resolveValue; });
    const get = vi.fn(async () => ({ settings: saved }));
    const ctx = { observationDeadlineAt: Date.now() + 390_000, input: { fixtures: { company: { id: "acorn" } }, api: { get }, page: {
      url: () => "https://fixture.test",
      waitForResponse: vi.fn((predicate: (row: unknown) => boolean) => {
        expect(predicate({ request: () => ({ method: () => "PUT" }), url: () => "https://fixture.test/api/companies/acorn/fast-response" })).toBe(true);
        for (const [method, path] of [["POST", "/api/companies/acorn/fast-response/test"], ["PUT", "/api/companies/foreign/fast-response"]])
          expect(predicate({ request: () => ({ method: () => method }), url: () => `https://fixture.test${path}` })).toBe(false);
        expect(predicate({ request: () => ({ method: () => "PUT" }), url: () => "https://foreign.test/api/companies/acorn/fast-response" })).toBe(false);
        return pending;
      }) } } };
    const reply = (status = 200, body = saved) => resolve({ status: () => status, json: async () => body });
    return { saved, ctx, get, reply, connection: { id: "shared", grantId: "grant" } };
  }
  it("waits for the real matching delayed PUT before reading persisted model", async () => {
    const f = fixture(); const click = vi.fn(async () => {});
    f.get.mockImplementation(async () => ({ settings: { ...f.saved, model: "stale" } }));
    const pending = saveFastResponseModelBeforeTest(f.ctx as never, f.connection as never, click);
    await Promise.resolve(); expect(f.get).not.toHaveBeenCalled();
    f.get.mockResolvedValue({ settings: f.saved }); f.reply();
    await expect(pending).resolves.toEqual(f.saved); expect(click).toHaveBeenCalledOnce(); expect(f.get).toHaveBeenCalledOnce();
  });
  it.each([403, 422, 500])("does not read or test after rejected save %s", async status => {
    const f = fixture(); const pending = saveFastResponseModelBeforeTest(f.ctx as never, f.connection as never, async () => {}); f.reply(status);
    await expect(pending).rejects.toThrow(/save completed successfully/); expect(f.get).not.toHaveBeenCalled();
  });
  it("rejects wrong PUT model and independently wrong persisted model", async () => {
    for (const responseWrong of [true, false]) {
      const f = fixture(); const pending = saveFastResponseModelBeforeTest(f.ctx as never, f.connection as never, async () => {});
      if (!responseWrong) f.get.mockResolvedValue({ settings: { ...f.saved, model: "wrong" } });
      f.reply(200, responseWrong ? { ...f.saved, model: "wrong" } : f.saved);
      await expect(pending).rejects.toThrow(/Requested auxiliary model saved/);
    }
  });
  it.each([{ companyId: "foreign" }, { connectionId: "foreign" }, { grantId: "foreign" }, { enabled: false }])("rejects wrong saved identity or disabled state %j", async wrong => {
    const f = fixture(); const pending = saveFastResponseModelBeforeTest(f.ctx as never, f.connection as never, async () => {});
    f.reply(200, { ...f.saved, ...wrong }); await expect(pending).rejects.toThrow(/Requested auxiliary model saved/);
    expect(f.get).not.toHaveBeenCalled();
  });
  it("never grants a fresh or unlimited deadline after delayed save", async () => {
    const f = fixture(); const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const pending = saveFastResponseModelBeforeTest(f.ctx as never, f.connection as never, async () => {});
    clock.mockReturnValue(now + 400_000); f.reply();
    await expect(pending).rejects.toThrow(/budget exhausted/); expect(f.get).not.toHaveBeenCalled(); clock.mockRestore();
  });
});
