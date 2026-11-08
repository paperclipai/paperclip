import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolveDefaultAgentWorkspaceDir } from "../../../server/src/home-paths.js";
import { prepareChatBrief } from "../chat-stories.js";
import { pollUntil } from "../api.js";
import { runtimeWorker, type RuntimeAgent } from "./runtime-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { Entity } from "./internal-support.js";
export interface RuntimeBriefGate { gate: string; ready: string; scriptPath: string; command: string; taskBound: boolean;
  gateName?: string; script?: string; boundTaskId?: string; boundWorkspaceId?: string }
export function taskBoundRuntimeGate(nonce: string, timeoutMs = 300_000): RuntimeBriefGate {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error("Task brief wait must remain bounded");
  const gateName = `runtime-brief-${createHash("sha256").update(nonce).digest("hex").slice(0, 24)}.txt`;
  const script = `const fs=require("node:fs");const gate=${JSON.stringify(gateName)};fs.writeFileSync(gate+".waiting","waiting",{flag:"wx"});const end=Date.now()+${timeoutMs};const timer=setInterval(()=>{if(fs.existsSync(gate)){console.log(fs.readFileSync(gate,"utf8"));clearInterval(timer)}else if(Date.now()>end){clearInterval(timer);process.exitCode=1}},100);`;
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  return { gate: "", ready: "", scriptPath: "", command: `node -e ${quote(script)}`, taskBound: true, gateName, script };
}
/** Bind only the actual assigned task's persisted workspace, never AGENT_HOME. */
export async function readRuntimeTaskGate(ctx: ChatCatalogContext, gate: RuntimeBriefGate, taskId: string, workerId: string) {
  if (!gate.taskBound || !gate.gateName) throw new Error("Expected task-bound brief listener");
  const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!root) throw new Error("Task gate requires the owned attempt root");
  const [task, view] = await Promise.all([
    ctx.input.api.get<{ id: string; companyId: string; assigneeAgentId: string | null; executionWorkspaceId: string | null }>(`/api/issues/${taskId}`),
    ctx.input.api.get<{ workspace: { id: string; companyId: string; cwd: string } }>(`/api/issues/${taskId}/workspace`),
  ]);
  if (task.id !== taskId || task.companyId !== ctx.input.fixtures.company.id || task.assigneeAgentId !== workerId
    || view.workspace.companyId !== task.companyId || view.workspace.id !== task.executionWorkspaceId)
    throw new Error("Task gate does not match the actual company, assignee and workspace binding");
  const cwd = await realpath(view.workspace.cwd), ownedRoot = await realpath(root);
  if (!cwd.startsWith(`${ownedRoot}${path.sep}`)) throw new Error("Task gate workspace escapes the owned attempt root");
  const filename = path.join(cwd, gate.gateName);
  if (gate.boundTaskId && (gate.boundTaskId !== taskId || gate.boundWorkspaceId !== view.workspace.id || gate.gate !== filename))
    throw new Error("Task gate binding changed after admission");
  gate.boundTaskId = taskId; gate.boundWorkspaceId = view.workspace.id; gate.gate = filename; gate.ready = `${filename}.waiting`;
  try {
    const ready = await realpath(gate.ready);
    if (path.dirname(ready) !== cwd) throw new Error("Task gate readiness path escapes its binding");
    return await readFile(ready, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
export async function prepareRuntimeWorkerGate(ctx: ChatCatalogContext, options: { worker?: RuntimeAgent; taskBound?: boolean } = {}) {
  if (ctx.input.execution.environment.id !== "local") throw new Error("Owned file-gate fixture requires a real local environment");
  const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT; if (!root) throw new Error("Busy fixture requires its isolated attempt root");
  const worker = options.worker ?? await runtimeWorker(ctx);
  const isolated = await realpath(root);
  const previousRuns = await ctx.allRuns();
  let gate: RuntimeBriefGate;
  if (options.taskBound) gate = taskBoundRuntimeGate(`${ctx.input.nonce}-${previousRuns.length}`);
  else {
    const candidate = path.resolve(resolveDefaultAgentWorkspaceDir(worker.id));
    if (!candidate.startsWith(`${isolated}${path.sep}`)) throw new Error("Busy fixture escaped its isolated company home");
    await mkdir(candidate, { recursive: true });
    const home = await realpath(candidate);
    if (!home.startsWith(`${isolated}${path.sep}`)) throw new Error("Busy fixture resolved outside its isolated company home");
    const original = await prepareChatBrief(home, `runtime-${ctx.input.nonce}-${previousRuns.length}`, 300_000);
    gate = { ...original, command: `node ${JSON.stringify(original.scriptPath)}`, taskBound: false };
  }
  const company = `/api/companies/${ctx.input.fixtures.company.id}`;
  const fundedAgents = [...new Set(options.taskBound ? [worker.id, ctx.input.fixtures.agent.id] : [worker.id])];
  for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, ...fundedAgents.map(scopeId => ({ scopeType: "agent", scopeId }))])
    await ctx.input.api.post(`${company}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  return { worker, gate, previousRuns, company };
}
export async function busyRuntimeWorker(ctx: ChatCatalogContext, options: { worker?: RuntimeAgent; observationDeadlineAt?: number } = {}) {
  const { worker, gate, previousRuns, company } = await prepareRuntimeWorkerGate(ctx, { ...options, taskBound: true });
  const task = await ctx.input.api.post<Entity>(`${company}/issues`, { title: "Website task", status: "todo", assigneeAgentId: worker.id,
    description: `The website brief is being supplied by the human. Run ${gate.command} once and wait for its real output. Do not invent a brief, replace the script, or mark work complete before it returns. Once the brief arrives, save it as a task document and finish normally.` });
  const running = await pollUntil({ label: "Real Morgan process waiting for its human brief", deadlineAt: options.observationDeadlineAt ?? Date.now() + 150_000,
    load: async () => ({ runs: (await ctx.allRuns()).filter(run => !previousRuns.some(prior => prior.id === run.id)), waiting: await readRuntimeTaskGate(ctx, gate, task.id, worker.id) }),
    accept: value => (options.observationDeadlineAt === undefined || Date.now() < options.observationDeadlineAt) && value.waiting === "waiting" && value.runs.length === 1 && value.runs[0]?.agentId === worker.id && value.runs[0].status === "running",
    reject: value => value.runs.some(run => ["failed", "cancelled", "timed_out", "succeeded"].includes(run.status)) ? "Busy fixture ended before its required active boundary" : undefined });
  return { worker, task, gate, workerRunId: running.runs[0]!.id, workerWasReallyWaiting: true };
}
export async function releaseRuntimeWorker(state: Record<string, unknown>) {
  const gate = state.gate as { gate?: string } | undefined;
  if (gate?.gate) await writeFile(gate.gate, "The human ended this disposable fixture. Preserve any saved work and finish normally.", "utf8");
}
