import { createHash } from "node:crypto";
import { pollUntil } from "../api.js";
import { checks, sameTask, type Entity } from "./internal-support.js";
import { agentLink, runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent, type InstructionFile } from "./runtime-support.js";
interface BuiltInState { definition: { key: string }; agentId: string | null; agent: RuntimeAgent | null; status: string }
/**
 * Agent instruction files persist without revision history (design change 14420):
 * a read reports a content token stamped with the reader, so the write's
 * attribution is the `agent.files_updated` audit row for the saved bytes.
 */
function agentInstructionSave(o: NonNullable<ReturnType<typeof runtimeObservation>>, workerId: string, content: string) {
  const contentHash = createHash("sha256").update(content).digest("hex");
  return o.activity.find(row => row.action === "agent.files_updated" && row.companyId === o.companyId && row.entityId === workerId
    && row.actorType === "agent" && row.actorId === o.leadId && row.agentId === o.leadId
    && row.details?.path === "AGENTS.md" && row.details.contentHash === contentHash
    && o.runs.some(run => run.id === (row as typeof row & { runId?: string }).runId));
}
function nonEmptyLines(content: string) { return content.split("\n").map(line => line.trim()).filter(Boolean); }
export function gradeBuiltInConfiguration(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("actual-built-in-observation", !!o, "The protected built-in registry, saved instruction file and historical task are independently read."); if (!o) return c.result();
  const original = o.state.builtInBefore as BuiltInState | undefined; const after = o.state.builtInAfter as BuiltInState | undefined;
  const beforeInstruction = o.state.originalInstruction as InstructionFile | undefined; const current = o.instruction;
  const worker = o.agents.find(row => row.id === original?.agentId);
  c.add("protected-identity-preserved", !!original && !!after && after.definition.key === "summarizer" && after.agentId === original.agentId
    && !!worker && worker.companyId === o.companyId && o.agents.length === o.state.agentCountBefore,
    "The required registry still points to the same summarizer, with no replacement ordinary hire.");
  // The wording of the new guidance is the model's own; grade that the run
  // itself saved a targeted edit of the built-in's bundled instructions.
  const originalLines = beforeInstruction ? nonEmptyLines(beforeInstruction.content) : [];
  const currentLines = new Set(current ? nonEmptyLines(current.content) : []);
  c.add("configuration-durably-saved-by-run", !!current && !!beforeInstruction && !!worker && current.content !== beforeInstruction.content
    && !!agentInstructionSave(o, worker.id, current.content),
    "The chat agent's own run saved changed instructions for the existing summarizer, and those bytes are what the product now serves.");
  c.add("targeted-edit-retains-summarizer-purpose", originalLines.length > 0
    && originalLines.filter(line => currentLines.has(line)).length * 2 >= originalLines.length,
    "The edit tunes the bundled summarizer instructions rather than replacing them wholesale.");
  c.add("history-retained", o.tasks.length === 1 && sameTask(o.state.historicalTask as Entity, o.tasks[0]),
    "The summarizer's attributed historical work remains intact.");
  c.add("names-configured-agent", !!worker && (!!agentLink(o, worker) || (!!worker.name && o.reply.includes(worker.name))),
    "The response identifies the summarizer whose configuration it changed.");
  return c.result();
}
export const runtimeBuiltInCases = [runtimeDefinition("agents.configure-required-agent", async ctx => {
  await ctx.input.api.patch("/api/instance/settings/experimental", { enableBuiltInAgents: true });
  const root = `/api/companies/${ctx.input.fixtures.company.id}`;
  const builtInBefore = await ctx.input.api.post<BuiltInState>(`${root}/built-in-agents/summarizer/reconcile`, {});
  if (!builtInBefore.agentId || !builtInBefore.agent) throw new Error("Public reconcile did not create the protected summarizer identity");
  const worker = builtInBefore.agent;
  const originalInstruction = await ctx.input.api.get<InstructionFile>(`/api/agents/${worker.id}/instructions-bundle/file?path=AGENTS.md`);
  const historicalTask = await ctx.input.api.post<Entity>(`${root}/issues`, { title: "Historical summary work", status: "backlog", assigneeAgentId: worker.id });
  const agentCountBefore = (await ctx.input.api.get<RuntimeAgent[]>(`${root}/agents`)).length;
  return { worker, builtInBefore, instructionAgentId: worker.id, originalInstruction, historicalTask, agentCountBefore };
}, gradeBuiltInConfiguration, {
  oracleVersion: "paperclip.chat-catalog.runtime.configure-required-agent.v3",
  sourceFiles: ["chat-catalog-domains/runtime-built-in.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/agents.yaml"],
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "protected-summarizer-identity", "historical-task-unrun"] },
  async verifySetup(ctx, state) {
    const c = checks();
    // Preserve the protected summarizer's real pause; only the ordinary source
    // agent must complete its asynchronous public readiness verification.
    const lead = await pollUntil({ label: "Required-agent configuration source readiness", deadlineAt: Date.now() + 45_000,
      load: () => ctx.input.api.get<RuntimeAgent & { lifecycleError?: string | null }>(`/api/agents/${ctx.input.fixtures.agent.id}`),
      accept: row => row.lifecycleState === "ready" && ["idle", "active"].includes(row.status ?? ""),
      reject: row => row.lifecycleError ? "Source runtime verification failed" : undefined });
    const builtIn = await ctx.input.api.get<BuiltInState>(`/api/companies/${ctx.input.fixtures.company.id}/built-in-agents/summarizer/status`);
    const history = await ctx.input.api.get<Entity>(`/api/issues/${(state.historicalTask as Entity).id}`);
    c.add("lead-ready", lead.lifecycleState === "ready" && ["idle", "active"].includes(lead.status ?? ""), "The actual chat agent is runnable.");
    c.add("protected-summarizer-identity", builtIn.definition.key === "summarizer" && builtIn.agentId === (state.worker as RuntimeAgent).id,
      "The genuine protected identity is preserved; readiness is never manufactured for this configuration-only request.");
    c.add("historical-task-unrun", history.status === "backlog" && (await ctx.allRuns()).length === 0, "The retained history fixture has not started provider work.");
    return c.result();
  },
  async observe(ctx, state) {
    state.builtInAfter = await ctx.input.api.get<BuiltInState>(`/api/companies/${ctx.input.fixtures.company.id}/built-in-agents/summarizer/status`);
    // The built-in bundle has no arbitrary side-file prerequisite.
    const result = await observeRuntime(ctx, { ...state, instructionAgentId: undefined });
    const root = `/api/agents/${(state.worker as RuntimeAgent).id}/instructions-bundle`;
    result.instruction = await ctx.input.api.get<InstructionFile>(`${root}/file?path=AGENTS.md`);
    result.instructionHistory = await ctx.input.api.get(`${root}/history?path=AGENTS.md`);
    return result;
  },
})];
