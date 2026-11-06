import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contextGuidanceArgv, runOwnedCli } from "./privileged-cli-support.js";
import { gradeChooseCliContext, privilegedCliCases } from "./privileged-cli.js";
import { settlePrivilegedChat } from "./privileged-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { readContext, upsertProfile, setCurrentProfile } from "../../../cli/src/client/context.js";
vi.mock("./internal-definition.js", () => ({ fixtureWorker: vi.fn() }));
vi.mock("./privileged-cli-support.js", async original => ({ ...await original<typeof import("./privileged-cli-support.js")>(), runOwnedCli: vi.fn() }));
vi.mock("./privileged-support.js", async original => ({ ...await original<typeof import("./privileged-support.js")>(), settlePrivilegedChat: vi.fn() }));
const fixture = { company: "owned-company", apiBase: "http://fixture.test" };
const fence = (text: string) => `\`\`\`bash\n${text}\n\`\`\``;
const exact = "paperclipai context set --profile acorn --company-id owned-company --persona board --use\npaperclipai company current\npaperclipai auth whoami";
const directories: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
it("accepts actual supported board-persona and company/identity readback with inherited configured API, without rewriting argv", () => {
  expect(contextGuidanceArgv(fence(exact), fixture)).toEqual({ commands: [
    ["context", "set", "--profile", "acorn", "--company-id", "owned-company", "--persona", "board", "--use"],
    ["company", "current"], ["auth", "whoami"]], bindings: [] });
});
it("accepts selecting the existing configured profile then reading its scoped company", () => {
  expect(contextGuidanceArgv(fence("paperclipai context use acorn\npaperclipai company current --json"), fixture)?.commands).toEqual([["context", "use", "acorn"], ["company", "current", "--json"]]);
});
it.each([exact.replace("owned-company", "foreign"), exact.replace("board", "agent"), exact.replace("--use", "--api-base https://foreign.invalid --use"),
  exact.replace("owned-company", "<acorn-company-id>"), exact.replace("owned-company", "<COMPANY_ID>"), exact.replace("owned-company", "$COMPANY_ID"),
  exact.replace("--persona board", "--agent-id attacker"), exact.replace("--persona board", "--api-key secret"), exact.replace("--persona board", "--invented yes"),
  exact.replace("--use", "--use --use"), exact.replace("acorn", "birch"), exact.replace("acorn", "Acorn"), exact.replace("company current", "company current --company-id foreign"),
  exact.replace("company current", "company list"), exact.replace("auth whoami", "auth login"), exact.replace("company current", "issue create --title nope"), exact + " ; curl bad.invalid",
  "paperclipai company current\npaperclipai context use acorn", "paperclipai context use acorn\npaperclipai auth whoami"])("rejects unsafe, unresolved, foreign or missing scoped readback: %s", text => {
  expect(contextGuidanceArgv(fence(text), fixture)).toBeUndefined();
});
it("actual production partial profile update preserves configured API and Birch while explicit board persona is retained", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "owned-cli-profile-")); directories.push(dir); const file = path.join(dir, "context.json");
  for (const [name, company] of [["acorn", fixture.company], ["birch", "other-company"]]) upsertProfile(name!, { apiBase: fixture.apiBase, companyId: company, persona: "board" }, file);
  setCurrentProfile("birch", file); const before = readContext(file);
  upsertProfile("acorn", { companyId: fixture.company, persona: "board" }, file); setCurrentProfile("acorn", file); const after = readContext(file);
  expect(after.currentProfile).toBe("acorn"); expect(after.profiles.acorn).toEqual({ apiBase: fixture.apiBase, companyId: fixture.company, persona: "board" });
  expect(after.profiles.birch).toEqual(before.profiles.birch);
});
it("requires independently executed context, actual scoped company and board persona rather than grammar alone", () => {
  const o = { scenarioId: "cli", origin: fixture.apiBase, companyId: fixture.company, leadId: "lead", projects: [], tasks: [], goals: [], comments: [], activity: [], documents: [], revisions: [], links: [], humanQueries: ["canonical"], runs: [{id:"native",status:"succeeded"}], reply: fence(exact),
    state: { initialProfile: "birch", finalProfile: "acorn", selectedCompanyId: fixture.company, selectedApiBase: fixture.apiBase, selectedPersona: "board", actualScopedCompanyId: fixture.company,
      contextCommandsExecuted: true, otherProfilePreserved: true, onlyOwnedContextWritten: true, operatorUserId: "person", identityIncludesSelectedCompany: true } };
  expect(gradeChooseCliContext(o).passed).toBe(true);
  for (const delta of [{ selectedPersona: "agent" }, { selectedPersona: undefined }, { actualScopedCompanyId: "foreign" }, { actualScopedCompanyId: undefined },
    { contextCommandsExecuted: false }, { identityIncludesSelectedCompany: false }, { otherProfilePreserved: false }])
    expect(gradeChooseCliContext({ ...o, state: { ...o.state, ...delta } }).passed).toBe(false);
});

it.each([fixture.company, "foreign"])("owning act executes unmodified returned commands then independently observes actual scoped company %s", async savedCompany => {
  const commands = contextGuidanceArgv(fence(exact), fixture)!.commands;
  const otherProfile = { companyId: "birch-company", apiBase: fixture.apiBase, persona: "board" };
  const profile = { companyId: fixture.company, apiBase: fixture.apiBase, persona: "board" };
  vi.mocked(settlePrivilegedChat).mockResolvedValue({ reply: fence(exact) } as never);
  vi.mocked(runOwnedCli).mockImplementation(async (_ctx, argv) => {
    // The first three calls are the returned sequence. Verification uses fresh
    // JSON reads after it, never treats a suggested command as an outcome.
    const index = vi.mocked(runOwnedCli).mock.calls.length;
    if (index <= commands.length) return "{}";
    if (argv[0] === "context") return JSON.stringify({ currentProfile: "acorn", contextPath: "/owned/context.json", profile, profiles: { acorn: profile, birch: otherProfile } });
    if (argv[0] === "company") return JSON.stringify({ id: savedCompany });
    return JSON.stringify({ userId: "person", companyIds: [fixture.company] });
  });
  const ctx = { observationDeadlineAt: Date.now() + 10_000, input: { api: { baseURL: fixture.apiBase }, fixtures: { company: { id: fixture.company } }, evidence: vi.fn() } } as unknown as ChatCatalogContext;
  const state: Record<string, unknown> = { initialProfile: "birch", operatorDirectory: "/owned", otherProfile };
  await privilegedCliCases.find(row => row.scenarioId === "cli-operations.choose-cli-context")!.act!(ctx, state);
  expect(vi.mocked(runOwnedCli).mock.calls.map(call => call[1])).toEqual([...commands, ["context", "show", "--json"], ["company", "current", "--json"], ["auth", "whoami", "--json"]]);
  expect(state.unresolvedContextBindings).toEqual([]); expect(state.actualScopedCompanyId).toBe(savedCompany);
  const observation = { scenarioId: "cli", origin: fixture.apiBase, companyId: fixture.company, leadId: "lead", projects: [], tasks: [], goals: [], comments: [], activity: [], documents: [], revisions: [], links: [], humanQueries: ["canonical"], runs: [{ id: "native", status: "succeeded" }], reply: fence(exact), state };
  expect(gradeChooseCliContext(observation).passed).toBe(savedCompany === fixture.company);
});
