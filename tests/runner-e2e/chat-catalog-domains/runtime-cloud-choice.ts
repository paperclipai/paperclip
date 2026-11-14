import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import type { IssueThreadInteraction } from "../../../packages/shared/src/types/issue.js";
import { expect } from "@playwright/test";
import { checks } from "./internal-support.js";
import { waitForReply } from "./identity-support.js";
import { interactionSurface, runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
import { runtimePrivateSpec, selectedRuntimeInputs } from "./runtime-private.js";
import { createOwnedDaytonaTarget, deleteOwnedDaytonaTarget, type OwnedDaytonaTarget } from "./runtime-daytona-target.js";
import { privateClaudeOperation } from "./runtime-claude-private.js";
export function cloudChoiceMatches(reply: string) {
  return /Claude\s*(?:Code)?/i.test(reply) && /(?:cloud|hosted|remote)\s+(?:computer|machine|environment|execution|runtime)|running (?:in|on) (?:the )?cloud/i.test(reply)
    && /which|do you mean|did you mean|choose|prefer|clarif|whether/i.test(reply) && /engineer|hire|role|developer/i.test(reply) && reply.length < 1200
    && !/claude_local|paperclip_runner|adapterType|acpxAgent|supply.*(?:adapter|internal).*id/i.test(reply)
    && !/(?:already|I(?:['’]ve| have))\s+(?:created|hired|selected|assigned)|(?:cloud code)\s+(?:definitely|always|clearly)\s+means/i.test(reply);
}
export function gradeCloudChoice(value: unknown) {
  const c = checks(), o = runtimeObservation(value); c.add("actual-two-available-context", !!o, "Both actually qualified possibilities and independent no-commit evidence are required."); if (!o) return c.result();
  const s = o.state;
  c.add("concrete-clarification-retains-role", cloudChoiceMatches(`${o.reply}\n${String(s.visibleChoiceText ?? "")}`) && s.questionVisible === true, "The actual human sees a short concrete Claude Code versus cloud-computer choice retaining the requested engineer role, with no internal adapter vocabulary.");
  c.add("waits-before-consequential-commit", s.claudeAvailable === true && s.cloudAvailable === true && s.noNewEmployee === true && s.originalBindingsUnchanged === true && s.sourceWaiting === true
    && o.runs.length === 1 && o.runs[0]?.agentId === o.leadId && o.runs[0].status === "succeeded" && o.tasks.length === 0 && o.humanQueries.length === 1,
    "Real available choices remain unselected: no employee, harness/computer binding or delegated task is committed before the person's answer.");
  return c.result();
}
export const runtimeCloudChoiceCases = [runtimeDefinition("agents.ambiguous-cloud-code", async ctx => {
  const target = await createOwnedDaytonaTarget(ctx);
  try {
    const selected = selectedRuntimeInputs(ctx, "agents.ambiguous-cloud-code"), companyId = ctx.input.fixtures.company.id;
    ctx.input.privateSecrets!.push(selected.credentials.ANTHROPIC_API_KEY!);
    const localAdapters = await ctx.input.api.get<Array<{ type: string; available?: boolean; supportedRunners?: string[] }>>(`/api/adapters?companyId=${companyId}&environmentId=${ctx.input.fixtures.environment.id}`);
    if (!localAdapters.some(row => row.type === "claude_local" && row.supportedRunners?.includes("legacy"))) throw new Error("Setup blocker: actual local Claude Code availability is missing; a cloud-only target does not establish the ambiguity context");
    const models = await ctx.input.api.get<Array<{ id: string }>>(`/api/companies/${companyId}/adapters/claude_local/models`);
    if (!models.length || !models[0]?.id) throw new Error("Actual authorized Claude model discovery returned no available model");
    const executable = (await promisify(execFile)("which", ["claude"], { timeout: 5000, maxBuffer: 4096 })).stdout.trim();
    const account = await privateClaudeOperation({ operation: "prepare-account", companyId, environmentId: ctx.input.fixtures.environment.id, credential: selected.credentials.ANTHROPIC_API_KEY!, harnessExecutable: executable, model: models[0].id, baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) });
    if (account.probeStatus !== "pass") throw new Error("Actual selected Claude command/account/model probe did not establish Claude Code availability");
    return { cloudTarget: target, cloudAvailable: true, claudeAvailable: true, beforeAgents: await ctx.input.api.get<Agent[]>(`/api/companies/${companyId}/agents`), providerProbes: [...target.providerProbes, { phase: "claude-availability", operation: account.operation, publicProbeCount: 2, status: account.probeStatus, usage: "unavailable", cost: "unavailable" }] };
  } catch (error) { await deleteOwnedDaytonaTarget(ctx, target); throw error; }
}, gradeCloudChoice, {
  ...runtimePrivateSpec("agents.ambiguous-cloud-code"), authentication: "human-session", expectedRunCount: 1, attemptTimeoutMs: 900000,
  sourceFiles: ["chat-catalog-domains/runtime-cloud-choice.ts", "chat-catalog-domains/runtime-daytona-target.ts", "chat-catalog-domains/runtime-private.ts", "chat-catalog-domains/runtime-claude-private.ts", "chat-catalog-domains/runtime-claude-private-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/external-private-browser.ts", "chat-catalog-domains/external-private-browser-worker.ts", "live-fixtures.ts", "../../packages/plugins/sandbox-providers/daytona/src/plugin.ts", "chat-scenarios/agents.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx); const source = ctx.issue()!, interactions = await ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${source.id}/interactions`);
    const questions = interactions.filter(row => row.kind === "ask_user_questions" && row.status === "pending");
    if (questions.length) {
      const runs = await ctx.allRuns();
      if (questions.some(row => row.sourceRunId !== runs[0]?.id || row.issueId !== source.id)) throw new Error("Clarification card is not attributed to the actual canonical source run");
      await expect(ctx.input.page.getByTestId("task-chat-unanswered-question").first()).toBeVisible();
      state.visibleChoiceText = await interactionSurface(ctx.input.page, questions[0]!).first().innerText();
    }
    else await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    state.questionVisible = questions.length > 0 || /\?|which|do you mean/i.test((await observeRuntime(ctx, state)).reply); state.sourceWaiting = source.conversationState === "waiting";
  },
  async observe(ctx, state) { const o = await observeRuntime(ctx, state), prior = state.beforeAgents as Agent[]; state.noNewEmployee = o.agents.length === prior.length && prior.every(before => o.agents.some(row => row.id === before.id)); state.originalBindingsUnchanged = prior.every(before => { const after = o.agents.find(row => row.id === before.id); return after?.adapterType === before.adapterType && JSON.stringify(after.adapterConfig) === JSON.stringify(before.adapterConfig) && after.defaultEnvironmentId === before.defaultEnvironmentId; }); return o; },
  async cleanup(ctx, state) { if (state.cloudTarget) await deleteOwnedDaytonaTarget(ctx, state.cloudTarget as OwnedDaytonaTarget); },
})];
