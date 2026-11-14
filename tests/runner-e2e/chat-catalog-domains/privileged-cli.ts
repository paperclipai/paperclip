import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { pollUntil } from "../api.js";
import type { RuntimeAgent } from "./runtime-support.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { checks, project, entity, type Entity } from "./internal-support.js";
import { fixtureWorker } from "./internal-definition.js";
import { privilegedDefinition, privilegedObservation, settlePrivilegedChat, remainingPrivilegedObservationBudget } from "./privileged-support.js";
import { prepareOwnedCli, runOwnedCli, cleanupOwnedCli, websiteCreateArgv, validContextGuidance, contextGuidanceArgv } from "./privileged-cli-support.js";

export function gradeCreateFromCli(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("actual-cli-observation", !!o, "The command returned by the actual model must run against the owned human CLI actor."); if (!o) return c.result();
  const cli = o.state.cliResult as Entity | undefined, saved = o.tasks.find(row => row.id === cli?.id);
  const worker = o.state.worker as Entity | undefined, launch = o.state.project as Entity | undefined;
  c.add("one-later-cli-created-task", o.state.tasksBeforeCli === 0 && o.tasks.length === 1 && !!cli?.id && saved?.id === cli.id
    && o.state.cliCommandExecuted === true && o.state.explicitCompany === o.companyId,
    "The later CLI journey creates exactly one task, rather than the agent creating work while merely asked for a command.");
  c.add("saved-company-project-assignee", !!saved && saved.companyId === o.companyId && saved.projectId === launch?.id
    && saved.assigneeAgentId === worker?.id && ["backlog", "todo"].includes(String(o.state.expectedCliStatus)) && saved.status === o.state.expectedCliStatus,
    "Fresh public state binds the task created by the returned command to Launch and Morgan; its title is model wording and is not graded.");
  c.add("real-command-structured-result", Array.isArray(o.state.executedArgv) && o.state.executedArgv[0] === "issue"
    && o.state.executedArgv[1] === "create" && cli?.companyId === saved?.companyId && cli?.projectId === saved?.projectId
    && cli?.assigneeAgentId === saved?.assigneeAgentId && cli?.status === saved?.status && o.state.cliStructuredResultVerified === true
    && o.state.workerWasManuallyPaused === true,
    "The response's finite supported flags actually execute with an inspectable structured result; no plausible invented flag is silently repaired.");
  return c.result();
}
const create = privilegedDefinition("cli-operations.create-from-cli", "privileged-cli", {
  async setup(ctx) {
    const operator = await prepareOwnedCli(ctx);
    const launch = await project(ctx), worker = await fixtureWorker(ctx);
    await ctx.input.api.post(`/api/agents/${worker.id}/pause`, {});
    const paused = await pollUntil({ label: "CLI fixture Morgan manually paused", deadlineAt: Date.now() + 45_000,
      load: () => ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`),
      accept: row => row.companyId === ctx.input.fixtures.company.id && row.lifecycleState === "paused"
        && row.status === "paused" && row.lifecycleHolds?.length === 1 && row.lifecycleHolds[0] === "manual" });
    return { ...operator, project: launch, worker: paused, workerWasManuallyPaused: true };
  },
  async act(ctx, state) {
    remainingPrivilegedObservationBudget(ctx);
    const reply = await settlePrivilegedChat(ctx, ctx.observationDeadlineAt);
    remainingPrivilegedObservationBudget(ctx);
    state.tasksBeforeCli = reply.tasks.length;
    const fixture = { company: ctx.input.fixtures.company.id, project: entity(state, "project").id,
      agent: entity(state, "worker").id, apiBase: ctx.input.api.baseURL };
    const bindings: Array<{ flag: string; placeholder: string; fixtureValue: string }> = [];
    const argv = websiteCreateArgv(reply.reply, fixture, bindings);
    const stdout = await runOwnedCli(ctx, argv);
    const cli = JSON.parse(stdout) as Entity;
    const statusIndex = argv.indexOf("--status");
    // Without --status the product creates an assigned task as todo (resolveCreateIssueStatusDefault).
    state.expectedCliStatus = statusIndex < 0 ? "todo" : argv[statusIndex + 1];
    const created = await ctx.input.api.get<Entity[]>(`/api/companies/${fixture.company}/issues`);
    if (reply.tasks.length || created.length !== 1) throw new Error("Actual returned CLI command did not create exactly one later task");
    const result = created[0]!;
    if (!cli?.id || cli.id !== result.id || cli.companyId !== fixture.company || cli.projectId !== fixture.project
      || cli.assigneeAgentId !== fixture.agent || cli.status !== state.expectedCliStatus || result.status !== cli.status || cli.title !== result.title)
      throw new Error("Actual CLI structured result does not match independently saved requested task");
    state.cliStructuredResultVerified = true;
    state.cliResult = { id: cli.id, companyId: cli.companyId, title: cli.title, identifier: cli.identifier,
      projectId: cli.projectId, assigneeAgentId: cli.assigneeAgentId, status: cli.status };
    state.executedArgv = argv.filter((value, index) => index < 2 || value.startsWith("-"));
    state.executedArgvSha256 = createHash("sha256").update(JSON.stringify(argv)).digest("hex");
    state.unresolvedIdentifierBindingPolicy = "Only explicit unresolved company/project/assignee placeholders bind to independently saved fixture identities; resolved values are never repaired.";
    state.unresolvedIdentifierBindings = bindings;
    state.explicitCompany = fixture.company; state.cliCommandExecuted = true;
    const saved = await ctx.input.api.get<Entity>(`/api/issues/${result.id}`);
    await ctx.input.evidence("chat-catalog-cli-created-task.json", { commandFlags: state.executedArgv, argvSha256: state.executedArgvSha256, bindingPolicy: state.unresolvedIdentifierBindingPolicy, result: state.cliResult,
      saved: { id: saved.id, companyId: saved.companyId, projectId: saved.projectId, assigneeAgentId: saved.assigneeAgentId, status: saved.status } });
  }, grade: gradeCreateFromCli,
  async verifyResult(ctx, state) {
    const row = state.cliResult as Entity;
    const source = ctx.input.page.url();
    await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/issues/${row.identifier ?? row.id}`, ctx.input.api.baseURL).href, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: row.title!, exact: true }).first()).toBeVisible();
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
});
create.sourceFiles = [...create.sourceFiles, "chat-catalog-domains/privileged-cli-support.ts", "../../cli/src/index.ts"];
create.cleanup = cleanupOwnedCli;
create.setupPolicy = { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "owned-manual-pause"] };
create.verifySetup = async (ctx, state) => {
  const c = checks();
  const lead = await pollUntil({ label: "CLI source agent ready", deadlineAt: Date.now() + 45_000,
    load: () => ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`),
    accept: row => row.lifecycleState === "ready" && ["idle", "active"].includes(row.status ?? "") });
  const worker = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${entity(state, "worker").id}`);
  c.add("lead-ready", lead.companyId === ctx.input.fixtures.company.id && lead.lifecycleState === "ready"
    && ["idle", "active"].includes(lead.status ?? ""), "The same-company source can receive the unchanged request.");
  c.add("owned-manual-pause", worker.companyId === ctx.input.fixtures.company.id && worker.lifecycleState === "paused"
    && worker.status === "paused" && worker.lifecycleHolds?.length === 1 && worker.lifecycleHolds[0] === "manual",
    "Morgan is genuinely manually paused before the command request, so later todo creation cannot admit hidden work.");
  return c.result();
};
export function gradeChooseCliContext(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("owned-cli-context-evidence", !!o, "Two isolated profiles and real authenticated identity readback are required."); if (!o) return c.result();
  c.add("supported-context-guidance", validContextGuidance(o.reply, { company: o.companyId, apiBase: o.origin }),
    "The answer supplies supported context/profile commands for the intended API and company instead of invented context flags.");
  c.add("actual-profile-selected", o.state.initialProfile === "birch" && typeof o.state.finalProfile === "string" && o.state.finalProfile !== o.state.initialProfile
    && o.state.selectedCompanyId === o.companyId && o.state.selectedApiBase === o.origin
    // `--persona` is an optional label; who runs the commands is graded from the authenticated identity below.
    && o.state.selectedPersona !== "agent" && o.state.actualScopedCompanyId === o.companyId && o.state.contextCommandsExecuted === true,
    "Supported CLI commands select a profile, other than the person's other one, holding the real Acorn company at its actual API base; the profile name is the model's choice.");
  c.add("other-profile-preserved", o.state.otherProfilePreserved === true && o.state.onlyOwnedContextWritten === true,
    "The other configured profile is byte-equivalent semantically, and only the explicit owned context path is used.");
  c.add("identity-readback", typeof o.state.operatorUserId === "string" && !!o.state.operatorUserId
    && o.state.identityIsBoardUser === true && o.state.identityIncludesSelectedCompany === true,
    "An actual authenticated CLI read confirms the human identity and membership before future writes.");
  return c.result();
}
const context = privilegedDefinition("cli-operations.choose-cli-context", "privileged-cli", {
  async setup(ctx) {
    const operator = await prepareOwnedCli(ctx);
    // The person calls this conversation's company "Acorn", so the company is
    // named that; otherwise the agent cannot tell Acorn is the company it is in.
    const acorn = await ctx.input.api.patch<Entity>(`/api/companies/${ctx.input.fixtures.company.id}`, { name: "Acorn" });
    if (acorn.name !== "Acorn") throw new Error("CLI context fixture company was not named Acorn");
    const birch = await ctx.input.api.post<Entity>("/api/companies", { name: `Birch ${ctx.input.nonce}` });
    for (const [name, companyId] of [["acorn", ctx.input.fixtures.company.id], ["birch", birch.id]])
      await runOwnedCli(ctx, ["context", "set", "--profile", name!, "--api-base", ctx.input.api.baseURL, "--company-id", companyId!, "--persona", "board", "--use", "--json"]);
    const before = JSON.parse(await runOwnedCli(ctx, ["context", "show", "--json"]));
    return { ...operator, initialProfile: before.currentProfile, otherProfile: before.profiles.birch };
  },
  async act(ctx, state) {
    remainingPrivilegedObservationBudget(ctx);
    const reply = await settlePrivilegedChat(ctx, ctx.observationDeadlineAt);
    remainingPrivilegedObservationBudget(ctx);
    const returned = contextGuidanceArgv(reply.reply, { company: ctx.input.fixtures.company.id, apiBase: ctx.input.api.baseURL });
    if (!returned) throw new Error("Actual model context commands are unsupported or do not select and read back the intended profile");
    for (const argv of returned.commands) await runOwnedCli(ctx, argv);
    state.returnedCommandHashes = returned.commands.map(argv => createHash("sha256").update(JSON.stringify(argv)).digest("hex"));
    state.unresolvedContextBindings = returned.bindings;
    state.recordedSignInCommands = returned.signIn.length;
    state.contextCommandsExecuted = true;
    const selected = JSON.parse(await runOwnedCli(ctx, ["context", "show", "--json"]));
    const scopedCompany = JSON.parse(await runOwnedCli(ctx, ["company", "current", "--json"]));
    const identity = JSON.parse(await runOwnedCli(ctx, ["auth", "whoami", "--json"]));
    state.finalProfile = selected.currentProfile; state.selectedCompanyId = selected.profile.companyId;
    state.selectedApiBase = selected.profile.apiBase;
    state.selectedPersona = selected.profile.persona; state.actualScopedCompanyId = scopedCompany.id;
    state.otherProfilePreserved = JSON.stringify(selected.profiles.birch) === JSON.stringify(state.otherProfile);
    state.onlyOwnedContextWritten = selected.contextPath === `${state.operatorDirectory}/context.json`;
    state.operatorUserId = identity.userId; state.identityIsBoardUser = !!identity.user && identity.user.id === identity.userId;
    state.identityIncludesSelectedCompany = identity.companyIds?.includes(ctx.input.fixtures.company.id) === true;
    await ctx.input.evidence("chat-catalog-cli-context-readback.json", { ...state, persona: "authenticated-human" });
  }, grade: gradeChooseCliContext,
  async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
});
context.sourceFiles = [...context.sourceFiles, "chat-catalog-domains/privileged-cli-support.ts", "../../cli/src/index.ts",
  "../../cli/src/commands/client/context.ts", "../../cli/src/commands/client/company.ts", "../../cli/src/commands/client/auth.ts", "../../cli/src/client/context.ts"];
context.oracleVersion = "paperclip.chat-catalog.cli-context.v4";
create.oracleVersion = "paperclip.chat-catalog.cli-create.v2";
context.cleanup = cleanupOwnedCli;
export const privilegedCliCases: ChatCatalogCase[] = [create, context];
