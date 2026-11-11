import { afterEach, expect, it, vi } from "vitest";
import { observeInternal } from "./internal-support.js";
import { runOwnedCli } from "./privileged-cli-support.js";
import { privilegedCliCases } from "./privileged-cli.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
vi.mock("./internal-definition.js", () => ({ fixtureWorker: vi.fn() }));
vi.mock("./internal-support.js", async original => ({
  ...await original<typeof import("./internal-support.js")>(), observeInternal: vi.fn(),
}));
vi.mock("./privileged-cli-support.js", async original => ({
  ...await original<typeof import("./privileged-cli-support.js")>(), runOwnedCli: vi.fn(),
}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const start = 50_000;
function fixture(scenario: string) {
  vi.useFakeTimers(); vi.setSystemTime(start);
  let completesAt = start + 160_000, status = "succeeded", noWork = false;
  const ctx = { observationDeadlineAt: start + 390_000,
    issue: () => ({ conversationState: Date.now() >= completesAt ? "waiting" : "running" }),
    input: { execution: { id: `chat-features.runner-opencode.local.${scenario}` },
      fixtures: { company: { id: "owned-company" } }, api: { baseURL: "http://fixture.test" } },
  } as unknown as ChatCatalogContext;
  vi.mocked(observeInternal).mockImplementation(async () => ({
    tasks: [], runs: noWork ? [] : [{ status: Date.now() >= completesAt ? status : "running" }],
    reply: Date.now() < completesAt ? "" : scenario.endsWith("choose-cli-context")
      ? "```bash\npaperclipai context use acorn\npaperclipai context show --json\n```"
      : '```bash\npaperclipai issue create --company-id <COMPANY_ID> --title "Website task" --project-id <PROJECT_ID> --assignee-agent-id <MORGAN_AGENT_ID>\n```',
  }) as never);
  vi.mocked(runOwnedCli).mockRejectedValue(new Error("Reached actual owned CLI boundary"));
  const d = privilegedCliCases.find(row => row.scenarioId === scenario)!;
  const act = () => Promise.resolve(d.act!(ctx, { project: { id: "launch" }, worker: { id: "morgan" } }));
  return { ctx, act, completesAt: (value: number) => { completesAt = value; }, status: (value: string) => { status = value; }, noWork: () => { noWork = true; } };
}
for (const scenario of ["cli-operations.choose-cli-context", "cli-operations.create-from-cli"]) {
  it(`${scenario}: reaches the genuine CLI boundary after160s only within its original clock`, async () => {
    const f = fixture(scenario); const pending = f.act().then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(160_000);
    expect((await pending)?.message).toBe("Reached actual owned CLI boundary");
    expect(runOwnedCli).toHaveBeenCalledOnce(); expect(f.ctx.observationDeadlineAt).toBe(start + 390_000);
  });
  it.each([undefined, NaN, Infinity, start, start - 1])(`${scenario}: rejects missing/invalid/expired deadline %s before observing or executing`, async deadline => {
    const f = fixture(scenario); Object.assign(f.ctx, { observationDeadlineAt: deadline });
    await expect(f.act()).rejects.toThrow(/Original privileged observation budget/);
    expect(observeInternal).not.toHaveBeenCalled(); expect(runOwnedCli).not.toHaveBeenCalled();
  });
  it.each(["failed", "cancelled", "timed_out"])(`${scenario}: rejects stopped/failed native work %s`, async status => {
    const f = fixture(scenario); f.completesAt(start); f.status(status);
    await expect(f.act()).rejects.toThrow(/Canonical guidance run failed/);
    expect(runOwnedCli).not.toHaveBeenCalled();
  });
  it(`${scenario}: a still-active or no-work turn cannot run CLI after its original deadline`, async () => {
    for (const noWork of [false, true]) {
      const f = fixture(scenario); Object.assign(f.ctx, { observationDeadlineAt: start + 1000 });
      f.completesAt(start + 2000); if (noWork) { f.completesAt(start); f.noWork(); }
      const pending = f.act().then(() => null, error => error as Error);
      await vi.advanceTimersByTimeAsync(4000);
      expect((await pending)?.message).toMatch(/Timed out waiting/); expect(runOwnedCli).not.toHaveBeenCalled();
    }
  });
  it(`${scenario}: late observation cannot cross the CLI boundary`, async () => {
    const f = fixture(scenario); Object.assign(f.ctx, { observationDeadlineAt: start + 1000 }); f.completesAt(start);
    const original = vi.mocked(observeInternal).getMockImplementation()!;
    vi.mocked(observeInternal).mockImplementation(async (...args) => { vi.setSystemTime(start + 1001); return original(...args); });
    const pending = f.act().then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await pending)?.message).toMatch(/Timed out waiting/); expect(runOwnedCli).not.toHaveBeenCalled();
  });
}
