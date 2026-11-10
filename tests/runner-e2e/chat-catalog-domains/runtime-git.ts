import { expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checks, sameTask, type Entity } from "./internal-support.js";
import { savedTaskWorkspace } from "./runtime-workspaces.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent } from "./runtime-support.js";
const exec = promisify(execFile);
async function ownedGit(cwd: string, args: string[]) {
  const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!root || !(await realpath(cwd)).startsWith(`${await realpath(root)}${path.sep}`)) throw new Error("Git fixture escaped the isolated task workspace");
  return (await exec("git", args, { cwd, timeout: 15_000, maxBuffer: 262_144 })).stdout;
}
export function gradeInspectGit(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("real-authorized-repository-evidence", !!o, "Actual task binding, owned repository baseline and independent before/after bytes are required."); if (!o) return c.result();
  const before = o.state.workspaceBefore as { workspace: { id: string; cwd: string } }; const after = o.state.workspaceAfter as typeof before;
  c.add("exact-task-repository-scope", !!before && !!after && before.workspace.id === after.workspace.id && before.workspace.cwd === after.workspace.cwd
    && o.state.nativeInspectionCwd === after.workspace.cwd && sameTask(o.state.task as Entity, o.tasks.find(row => row.id === (o.state.task as Entity).id))
    && o.tasks.length === 1 && o.state.noRemote === true,
  "The actual chat native workspace is the exact authorized bound task checkout, without an unrelated checkout or configured remote.");
  c.add("real-uncommitted-header-and-unrelated-change", typeof o.state.diffBefore === "string" && /diff --git a\/header.html b\/header.html/.test(o.state.diffBefore)
    && /Launch later/.test(o.state.diffBefore) && /Launch sooner/.test(o.state.diffBefore)
    && /diff --git a\/existing-notes.txt b\/existing-notes.txt/.test(o.state.diffBefore)
    && o.state.diffAfter === o.state.diffBefore && o.state.statusAfter === o.state.statusBefore && o.state.headAfter === o.state.headBefore
    && o.state.headerAfter === o.state.headerBefore && o.state.notesAfter === o.state.notesBefore,
  "Both real synthetic edits and the committed baseline remain byte-for-byte unchanged by this inspection.");
  c.add("actual-diff-summary-with-file-references", /header\.html/.test(o.reply) && /Launch later/i.test(o.reply) && /Launch sooner/i.test(o.reply)
    && /existing-notes\.txt/.test(o.reply) && /uncommitted|working (?:tree|copy)|not (?:yet )?committed/i.test(o.reply)
    && !/(?:I(?:'ve| have)? |successfully )(?:pushed|committed|published|deployed)|remote.*(?:has been|was) updated/i.test(o.reply),
  "The answer describes the observed header and unrelated diff, distinguishes uncommitted work and makes no remote-update claim.");
  c.add("real-native-inspection-only", o.runs.length === 2 && o.runs.every(run => run.status === "succeeded")
    && o.runs.filter(run => run.agentId === o.leadId).length === 1,
  "The real prior workspace setup and one native inspection are the only provider executions.");
  return c.result();
}
export const runtimeGitCases = [runtimeDefinition("workspaces.inspect-git", async ctx => {
  if (ctx.input.execution.environment.id !== "local") throw new Error("Owned repository fixture requires the actual local runtime");
  const state = await savedTaskWorkspace(ctx); const cwd = state.workspaceBefore.workspace.cwd;
  await ownedGit(cwd, ["init", "--initial-branch=eval-fixture"]);
  if ((await ownedGit(cwd, ["remote"])).trim()) throw new Error("Disposable synthetic task repository unexpectedly has a remote");
  const header = path.join(cwd, "header.html"), notes = path.join(cwd, "existing-notes.txt");
  await writeFile(header, `<h1>Launch later</h1>\n<!-- ${ctx.input.nonce} -->\n`, "utf8");
  await writeFile(notes, "Existing unrelated notes before the user's edit.\n", "utf8");
  await ownedGit(cwd, ["add", "--", "header.html", "existing-notes.txt"]);
  await ownedGit(cwd, ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Paperclip Eval Fixture", "-c", "user.email=fixture@invalid.example", "commit", "-m", "Synthetic baseline for the owned diff fixture"]);
  await writeFile(header, `<h1>Launch sooner</h1>\n<!-- ${ctx.input.nonce} -->\n`, "utf8");
  await writeFile(notes, `Existing unrelated notes preserved with human amendment ${ctx.input.nonce}.\n`, "utf8");
  const lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
  await ctx.input.api.patch(`/api/agents/${lead.id}`, { adapterConfig: { ...lead.adapterConfig, cwd } });
  await ctx.input.api.patch("/api/instance/settings/experimental", { enableExperimentalFileViewer: true });
  return { ...state, nativeInspectionCwd: cwd, noRemote: true, headBefore: await ownedGit(cwd, ["rev-parse", "HEAD"]),
    diffBefore: await ownedGit(cwd, ["diff", "--", "header.html", "existing-notes.txt"]), statusBefore: await ownedGit(cwd, ["status", "--porcelain"]),
    headerBefore: await readFile(header, "utf8"), notesBefore: await readFile(notes, "utf8") };
}, gradeInspectGit, {
  sourceFiles: ["chat-catalog-domains/runtime-git.ts", "chat-catalog-domains/runtime-workspaces.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/workspaces.yaml"],
  expectedRunCount: 2, attemptTimeoutMs: 540_000,
  async observe(ctx, state) {
    const cwd = String(state.nativeInspectionCwd);
    state.workspaceAfter = await ctx.input.api.get(`/api/issues/${(state.task as Entity).id}/workspace`);
    state.headAfter = await ownedGit(cwd, ["rev-parse", "HEAD"]); state.diffAfter = await ownedGit(cwd, ["diff", "--", "header.html", "existing-notes.txt"]);
    state.statusAfter = await ownedGit(cwd, ["status", "--porcelain"]);
    state.headerAfter = await readFile(path.join(cwd, "header.html"), "utf8"); state.notesAfter = await readFile(path.join(cwd, "existing-notes.txt"), "utf8");
    return observeRuntime(ctx, state);
  },
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url(), task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible();
    await ctx.input.page.getByRole("button", { name: "Open a new tab", exact: true }).click();
    await ctx.input.page.getByRole("option", { name: /^Files/ }).click();
    await expect(ctx.input.page.getByText("header.html", { exact: true }).first()).toBeVisible();
    await expect(ctx.input.page.getByText("existing-notes.txt", { exact: true }).first()).toBeVisible();
    await ctx.input.evidence("runtime-authorized-git-files-ui.json", { taskId: task.id, workspaceId: (state.workspaceBefore as { workspace: { id: string } }).workspace.id, url: ctx.input.page.url() });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
})];
