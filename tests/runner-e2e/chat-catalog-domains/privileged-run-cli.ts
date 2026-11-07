import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, observeInternal } from "./internal-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { privilegedDefinition, privilegedObservation } from "./privileged-support.js";
import { prepareOwnedCli, runOwnedCli, cleanupOwnedCli } from "./privileged-cli-support.js";

export function inspectRunCommands(reply: string, runId: string) {
  const matches = [...reply.matchAll(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g)]
    .flatMap(match => match[1]!.replace(/\\\r?\n/g, " ").split(/\r?\n/))
    .map(line => line.trim()).filter(line => /^(?:paperclipai|npx(?: -y)? paperclipai|pnpm (?:exec )?paperclipai)\s+run\s+(?:get|cancel)\b/.test(line));
  const commands: string[][] = [], bindings: Array<{ placeholder: string; fixtureValue: string }> = [];
  for (const line of matches) {
    const parsed = line.match(/^(?:paperclipai|npx(?: -y)? paperclipai|pnpm (?:exec )?paperclipai)\s+run\s+(get|cancel)\s+(\S+)(?:\s+(--json))?$/);
    if (!parsed) throw new Error("Unsupported run command flags or shell syntax");
    let id = parsed[2]!;
    if (/^(?:<[A-Z_ -]+>|\$\{?[A-Z_]+\}?)$/.test(id)) { bindings.push({ placeholder: id, fixtureValue: runId }); id = runId; }
    if (id !== runId) throw new Error("Run command names a different native run");
    commands.push(["run", parsed[1]!, id, ...(parsed[3] ? [parsed[3]] : [])]);
  }
  if (commands.length !== 2 || commands[0]?.[1] !== "get" || commands[1]?.[1] !== "cancel") throw new Error("Read the exact run before the separate authorized cancellation command");
  return { commands, bindings };
}
export function gradeInspectRunCli(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("run-companion-observation", !!o, "Actual read-before-cancel state and the owned native worker run are required."); if (!o) return c.result();
  c.add("read-exact-last-morgan-run", o.state.initialRunReallyRunning === true && o.state.readRunId === o.state.workerRunId
    && o.state.readAgentId === (o.state.worker as { id?: string } | undefined)?.id && o.state.readCompanyId === o.companyId
    && o.state.readStatus === "running", "The actual CLI read selects Morgan's exact current run, rather than a stale or other-company run.");
  c.add("board-only-control", o.state.agentCancelStatus === 403 && /board|human|operator/i.test(o.reply)
    && /agent.{0,60}(?:cannot|can't|not|insufficient)|(?:cannot|can't|not|insufficient).{0,60}agent/i.test(o.reply),
    "A real agent bearer is denied cancellation; guidance distinguishes the read command and required human control actor.");
  c.add("actual-cancelled-result", o.state.cancelRunId === o.state.workerRunId && o.state.finalWorkerStatus === "cancelled"
    && o.state.cancelOnlyAfterRead === true && o.runs.length === 2
    && o.runs.filter(run => run.status === "cancelled" && run.id === o.state.workerRunId).length === 1
    && o.runs.filter(run => run.status === "succeeded" && run.agentId === o.leadId).length === 1,
    "The owned human CLI actually cancels the same running worker, with one successful canonical guidance run and no duplicate admission.");
  c.add("no-premature-success-claim", !/(?:I(?:'ve| have)?|already|successfully)\s+(?:stopped|cancelled|canceled)\s+(?:Morgan|the run|it)/i.test(o.reply),
    "The earlier guidance cannot claim the later authorized cancellation already happened.");
  return c.result();
}
const probeKeys = new WeakMap<ChatCatalogContext, { id: string; token: string }>();
const inspect = privilegedDefinition("cli-operations.inspect-run-cli", "privileged-run-cli", {
  async setup(ctx) {
    const operator = await prepareOwnedCli(ctx), busy = await busyRuntimeWorker(ctx);
    if (!ctx.input.privateSecrets) throw new Error("Private actor probe redaction is unavailable");
    const key = await ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${ctx.input.fixtures.agent.id}/keys`, { name: `catalog-run-control-${ctx.input.nonce}` });
    ctx.input.privateSecrets.push(key.token); probeKeys.set(ctx, key);
    const response = await fetch(new URL(`/api/heartbeat-runs/${busy.workerRunId}/cancel`, ctx.input.api.baseURL), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" }, body: "{}" });
    const agentCancelStatus = response.status; await response.body?.cancel();
    return { ...operator, ...busy, agentCancelStatus, initialRunReallyRunning: busy.workerWasReallyWaiting };
  },
  async act(ctx, state) {
    const initial = await pollUntil({ label: "Canonical run-control guidance", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: () => observeInternal(ctx, state), accept: o => chatCatalogNativePhaseIsTimely(ctx) && (!!o.reply && ctx.issue()?.conversationState === "waiting"
        && o.runs.filter(run => run.agentId === ctx.input.fixtures.agent.id && run.status === "succeeded").length === 1) });
    const returned = inspectRunCommands(initial.reply, String(state.workerRunId));
    await runOwnedCli(ctx, returned.commands[0]!);
    const read = await ctx.input.api.get<{ id: string; agentId: string; companyId: string; status: string }>(`/api/heartbeat-runs/${state.workerRunId}`);
    state.readRunId = read.id; state.readAgentId = read.agentId; state.readCompanyId = read.companyId; state.readStatus = read.status;
    if (read.id !== state.workerRunId || read.companyId !== ctx.input.fixtures.company.id || read.agentId !== (state.worker as { id: string }).id) throw new Error("CLI read did not verify the exact owned Morgan run");
    if (read.status === "running") {
      await runOwnedCli(ctx, returned.commands[1]!);
      state.cancelRunId = read.id; state.cancelOnlyAfterRead = true;
    }
    const final = await pollUntil({ label: "Actual owned run cancellation", deadlineAt: Date.now() + 60_000,
      load: () => ctx.input.api.get<{ id: string; status: string }>(`/api/heartbeat-runs/${state.workerRunId}`), accept: row => row.status === "cancelled" });
    state.finalWorkerStatus = final.status;
    state.commandHashes = returned.commands.map(argv => createHash("sha256").update(JSON.stringify(argv)).digest("hex"));
    state.unresolvedRunBindings = returned.bindings;
    await ctx.input.evidence("chat-catalog-cli-run-control.json", { workerRunId: state.workerRunId, readRunId: state.readRunId,
      readStatus: state.readStatus, finalStatus: final.status, actor: "authenticated-human", commandHashes: state.commandHashes });
  }, grade: gradeInspectRunCli,
  async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
});
inspect.expectedRunCount = 2; inspect.expectedHumanMessageCount = 1; inspect.attemptTimeoutMs = 600_000;
inspect.runPolicy = { kind: "terminal-counts", terminalStatusCounts: { succeeded: 1, cancelled: 1 } };
inspect.sourceFiles = [...inspect.sourceFiles, "chat-catalog-domains/privileged-cli-support.ts", "chat-catalog-domains/runtime-busy-worker.ts", "../../cli/src/index.ts"];
inspect.cleanup = async (ctx, state) => {
  await releaseRuntimeWorker(state);
  try { const key = probeKeys.get(ctx); if (key) { await ctx.input.api.delete(`/api/agents/${ctx.input.fixtures.agent.id}/keys/${key.id}`); probeKeys.delete(ctx); } }
  finally { await cleanupOwnedCli(ctx); }
};
export const privilegedRunCliCases = [inspect];
