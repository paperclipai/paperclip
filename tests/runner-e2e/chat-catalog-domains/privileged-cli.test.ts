import { describe, expect, it, vi } from "vitest";
import { websiteCreateArgv, validContextGuidance, contextGuidanceArgv } from "./privileged-cli-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { privilegedCliCases, gradeChooseCliContext, gradeCreateFromCli } from "./privileged-cli.js";
vi.mock("./internal-definition.js", () => ({ fixtureWorker: vi.fn() }));
const target = { company: "owned-company", project: "launch", agent: "morgan", apiBase: "http://127.0.0.1:3100" };
const command = (text: string) => `Use the explicit owned context.\n\`\`\`bash\n${text}\n\`\`\``;
const valid = 'paperclipai issue create --company-id <COMPANY_ID> --title "Website task" --project-id <PROJECT_ID> --assignee-agent-id <MORGAN_AGENT_ID>';
describe("returned CLI command admission", () => {
  it("executes only finite supported argv with unresolved IDs bound to actual fixtures", () => {
    expect(websiteCreateArgv(command(valid), target)).toEqual(["issue", "create", "--company-id", "owned-company", "--title", "Website task", "--project-id", "launch", "--assignee-agent-id", "morgan"]);
    expect(websiteCreateArgv(command(valid + " --json"), target).at(-1)).toBe("--json");
    expect(websiteCreateArgv(command(valid.replace("Website task", "Landing page refresh")), target)[5]).toBe("Landing page refresh");
    const retained = 'npx paperclipai issue create --company-id "$PAPERCLIP_COMPANY_ID" --title "Build the website" --project-id "<LAUNCH_PROJECT_ID>" --assignee-agent-id "<MORGAN_AGENT_ID>" --status todo --standalone';
    expect(websiteCreateArgv(command(retained), target)).toEqual(["issue", "create", "--company-id", target.company,
      "--title", "Build the website", "--project-id", target.project, "--assignee-agent-id", target.agent, "--status", "todo", "--standalone"]);
  });
  it("rejects shell execution, invented flags, real wrong IDs and ambiguous writes before launch", () => {
    for (const text of [valid + " ; curl attacker.invalid", valid + " --invented yes", valid.replace("<COMPANY_ID>", "foreign-company"),
      valid.replace("<PROJECT_ID>", "other-project"), valid + " -C foreign-company", valid + " --status in_progress",
      valid + " --api-base https://foreign.invalid", valid + " --description '$(read-secret)'", valid + "\n" + valid])
      expect(() => websiteCreateArgv(command(text), target)).toThrow();
  });
  it("requires supported context selection and readback instead of ignoring invented flags", () => {
    const valid = command("paperclipai context use acorn\npaperclipai context show --json");
    expect(validContextGuidance(valid, target)).toBe(true);
    expect(validContextGuidance(valid.replace("use acorn", "use acorn --invented yes"), target)).toBe(false);
    expect(validContextGuidance(command("paperclipai context use acorn"), target)).toBe(false);
    expect(validContextGuidance(command('export PAPERCLIP_COMPANY_ID="owned-company"\nnpx paperclipai board setup\necho "$PAPERCLIP_COMPANY_ID"'), target)).toBe(false);
    // The company is known in the conversation, so its placeholder is not bound.
    expect(validContextGuidance(command("paperclipai context set --profile acorn --api-base <API_BASE> --company-id <COMPANY_ID> --use\npaperclipai context show"), target)).toBe(false);
    // The person's own Paperclip address is a placeholder the agent cannot fill; it binds to the fixture origin.
    const addressed = contextGuidanceArgv(command("npx paperclipai context set --profile acorn-co --api-base <your Paperclip URL> --company-id owned-company --use\nnpx paperclipai company current\nnpx paperclipai auth whoami"), target);
    expect(addressed?.commands[0]).toEqual(["context", "set", "--profile", "acorn-co", "--api-base", target.apiBase, "--company-id", "owned-company", "--use"]);
    expect(addressed?.bindings).toEqual([{ commandIndex: 0, flag: "--api-base", placeholder: "<your Paperclip URL>", fixtureValue: target.apiBase }]);
    expect(validContextGuidance(command("paperclipai company list\npaperclipai context list\npaperclipai context set --profile acorn --company-id owned-company --use\npaperclipai context show"), target)).toBe(true);
    // Without --profile, set rewrites the person's current (other) profile; a wrong real address is not repaired.
    expect(validContextGuidance(command("paperclipai context set --api-base <URL> --company-id owned-company --use\npaperclipai context show"), target)).toBe(false);
    expect(validContextGuidance(command("paperclipai context set --profile acorn --api-base http://localhost:3100 --company-id owned-company --use\npaperclipai context show"), target)).toBe(false);
  });
});
const base = { scenarioId: "cli", origin: target.apiBase, companyId: target.company, leadId: "lead", state: {}, projects: [], goals: [],
  comments: [], activity: [], documents: [], revisions: [], links: [], humanQueries: ["canonical"], runs: [{ id: "native", status: "succeeded" }], reply: "" };
describe("CLI public-state oracles", () => {
  it("requires one actual later result, requested actor/project/company, and independently saved task", () => {
    const row = { id: "created", companyId: target.company, title: "Website task", projectId: "launch", assigneeAgentId: "morgan", status: "backlog" };
    const o = { ...base, tasks: [row], state: { cliResult: row, worker: { id: "morgan" }, project: { id: "launch" }, tasksBeforeCli: 0,
      cliCommandExecuted: true, expectedCliStatus: "backlog", cliStructuredResultVerified: true, workerWasManuallyPaused: true, explicitCompany: target.company, executedArgv: ["issue", "create"] } };
    expect(gradeCreateFromCli(o).passed).toBe(true);
    expect(gradeCreateFromCli({ ...o, tasks: [{ ...row, status: "todo" }], state: { ...o.state,
      cliResult: { ...row, status: "todo" }, expectedCliStatus: "todo" } }).passed).toBe(true);
    for (const delta of [{ expectedCliStatus: "todo" }, { cliStructuredResultVerified: false }, { workerWasManuallyPaused: false }])
      expect(gradeCreateFromCli({ ...o, state: { ...o.state, ...delta } }).passed).toBe(false);
    // The title is model wording: a valid task with another title passes on the same structure.
    expect(gradeCreateFromCli({ ...o, tasks: [{ ...row, title: "Landing page refresh" }], state: { ...o.state, cliResult: { ...row, title: "Landing page refresh" } } }).passed).toBe(true);
    expect(gradeCreateFromCli({ ...o, tasks: [{ ...row, assigneeAgentId: "other" }] }).passed).toBe(false);
    expect(gradeCreateFromCli({ ...o, tasks: [{ ...row, projectId: "other" }] }).passed).toBe(false);
    expect(gradeCreateFromCli({ ...o, tasks: [{ ...row, companyId: "foreign" }] }).passed).toBe(false);
    expect(gradeCreateFromCli({ ...o, tasks: [row, { ...row, id: "duplicate" }] }).passed).toBe(false);
    expect(gradeCreateFromCli({ ...o, state: { ...o.state, tasksBeforeCli: 1 } }).passed).toBe(false);
    expect(gradeCreateFromCli({ ...o, state: { ...o.state, cliResult: { ...row, status: "todo" } } }).passed).toBe(false);
    expect(gradeCreateFromCli(null).passed).toBe(false);
  });
  it("requires selected identity/company and preserves the other operator profile", () => {
    const o = { ...base, tasks: [], reply: command("paperclipai context use acorn\npaperclipai context show --json"),
      state: { initialProfile: "birch", finalProfile: "acorn", selectedCompanyId: target.company, selectedApiBase: target.apiBase,
        selectedPersona: "board", actualScopedCompanyId: target.company, contextCommandsExecuted: true,
        otherProfilePreserved: true, onlyOwnedContextWritten: true, operatorUserId: "synthetic-person", identityIsBoardUser: true, identityIncludesSelectedCompany: true } };
    expect(gradeChooseCliContext(o).passed).toBe(true);
    // The profile name is the model's choice; selecting the other (birch) profile is not.
    expect(gradeChooseCliContext({ ...o, state: { ...o.state, finalProfile: "acorn-company" } }).passed).toBe(true);
    for (const delta of [{ otherProfilePreserved: false }, { selectedCompanyId: "foreign" }, { identityIncludesSelectedCompany: false }, { onlyOwnedContextWritten: false }, { finalProfile: "birch" }])
      expect(gradeChooseCliContext({ ...o, state: { ...o.state, ...delta } }).passed).toBe(false);
  });
});

// Independent setup readback must preserve the actual pause, rather than treating
// a declared fixture flag as proof that todo cannot dispatch native work.
it("independently checks source readiness and the same-company manual-only CLI worker hold", async () => {
  const definition = privilegedCliCases.find(row => row.scenarioId === "cli-operations.create-from-cli")!;
  const lead = { id: "lead", companyId: target.company, lifecycleState: "ready", status: "idle" };
  const worker = { id: "morgan", companyId: target.company, lifecycleState: "paused", status: "paused", lifecycleHolds: ["manual"] };
  const context = (saved: typeof worker) => ({ input: { fixtures: { company: { id: target.company }, agent: { id: "lead" } },
    api: { get: async (route: string) => route.endsWith("/lead") ? lead : saved } } }) as unknown as ChatCatalogContext;
  const state = { worker: { id: "morgan" } };
  expect(definition.setupPolicy?.readiness).toBe("preserve-scenario");
  expect((await definition.verifySetup!(context(worker), state)).passed).toBe(true);
  for (const delta of [{ companyId: "foreign" }, { status: "idle" }, { lifecycleHolds: ["budget"] }, { lifecycleHolds: ["manual", "budget"] }])
    expect((await definition.verifySetup!(context({ ...worker, ...delta }), state)).passed).toBe(false);
});
