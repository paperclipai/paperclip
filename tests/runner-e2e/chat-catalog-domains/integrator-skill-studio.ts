import { saveSkillConversationContext } from "./integrator-skill-context.js";
import { factualContextQueryAttachment } from "../chat-query-attachments.js";
import { expect } from "@playwright/test";
import type { CompanySkillDetail, CompanySkillTestInput, CompanySkillTestRun, CompanySkillTestRunDetail } from "../../../packages/shared/src/types/company-skill.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, observation, project, type Entity, type InternalObservation } from "./internal-support.js";
import { fixtureWorker } from "./internal-definition.js";
import { integratorDefinition, observeInternal } from "./integrator-support.js";
export const studioPageInput = '<!doctype html><html lang="en"><head><title>Synthetic landing page</title></head><body><main><h1>Launch trial</h1><form><input type="email" id="trial-email"><button type="submit">Join trial</button></form></main></body></html>';
const studioMarkdown = "---\nname: accessibility-review\ndescription: Review supplied synthetic HTML for accessibility.\n---\n\nInspect the provided input only. Check that every input has a visible associated label. Record the exact element and evidence for any failed check. Do not invent browser tests or claim production qualification. Save the requested test output and complete the test task; do not create other work.";
const root = (ctx: ChatCatalogContext, skillId: string) => `/api/companies/${ctx.input.fixtures.company.id}/skills/${skillId}`;
interface StudioObservation extends InternalObservation { skill: CompanySkillDetail; studioRuns: CompanySkillTestRunDetail[] }
async function observeStudio(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<StudioObservation> {
  const base = await observeInternal(ctx, state); const path = root(ctx, (state.skill as CompanySkillDetail).id);
  const runs = await ctx.input.api.get<CompanySkillTestRun[]>(`${path}/test-runs`);
  return { ...base, skill: await ctx.input.api.get<CompanySkillDetail>(path), studioRuns: await Promise.all(runs.map(run => ctx.input.api.get<CompanySkillTestRunDetail>(`${path}/test-runs/${run.id}`))) };
}
function studioObservation(value: unknown): StudioObservation | undefined {
  const o = value as StudioObservation;
  return observation(value) && !!o.skill && Array.isArray(o.studioRuns) ? o : undefined;
}
export function gradeIntegratorSkillStudio(value: unknown) {
  const c = checks(); const o = studioObservation(value);
  c.add("saved-studio-input-execution-output", !!o, "Requires public Studio run detail and actual native harness evidence.");
  if (!o) return c.result();
  const before = o.state.skill as CompanySkillDetail; const input = o.state.input as CompanySkillTestInput; const worker = o.state.worker as Entity;
  const run = o.studioRuns[0];
  c.add("one-pinned-synthetic-test", o.studioRuns.length === 1 && !!run && run.companyId === o.companyId && run.skillId === before?.id && run.agentId === worker?.id
    && run.skillVersionId === before?.currentVersionId && run.skillVersion.id === before?.currentVersionId && run.inputId === input?.id && run.inputSnapshot === studioPageInput
    && run.skillVersion.fileInventory.some(file => file.path === "SKILL.md" && "content" in file && file.content === before.markdown),
  "Exactly one bounded test retains the actual selected writable revision and synthetic input bytes.");
  const native = run && o.runs.find(row => row.agentId === worker?.id && row.contextSnapshot?.issueId === run.issueId);
  c.add("actual-native-harness-completion", !!run && run.status === "succeeded" && !!native && native.runtimeMode === "native" && native.status === "succeeded"
    && run.harnessIssue?.id === run.issueId && run.harnessIssue.status === "done" && run.harnessContent.available,
  "Studio success is backed by a real completed native harness task; it is not a fabricated test row or another task's run.");
  const output = run?.outputBody ?? "";
  c.add("saved-concrete-sample-failure", !!run && output.length > 0 && output === run.outputSnapshot
    && /trial-email|email (?:input|field)/i.test(output) && /\b(?:label|labelled|labeled)\b/i.test(output)
    && /\b(?:missing|absent|no (?:visible |associated )?label|unlabelled|unlabeled|fails?|without)\b/i.test(output)
    && !/\b(?:all checks pass|no accessibility (?:issues|failures)|(?:input|field) (?:has|includes) (?:a )?(?:visible |associated )?label)\b/i.test(output)
    && run.documents.some(doc => doc.key === run.outputDocumentKey && doc.body === output),
  "The saved inspectable output identifies the genuine missing label on the supplied email input; a successful test execution cannot turn a failing sample into a clean page.");
  c.add("no-unrelated-work-or-skill-mutation", o.skill.currentVersionId === before?.currentVersionId && o.skill.markdown === before.markdown
    && o.tasks.every(task => task.id === run?.issueId) && !o.activity.some(event => event.agentId === o.leadId && event.action === "company.skill_file_updated"),
  "The test does not rewrite its tested revision or create unrelated production tasks.");
  c.add("bounded-report-not-global-qualification", !/\b(?:all|every)\s+(?:production )?(?:agents?|pages?|websites?)\b[^.!?\n]{0,45}\b(?:qualified|passed|accessible|verified|enabled)\b/i.test(o.reply)
    && !(/\b(?:test|run)\b[^.!?\n]{0,35}\b(?:passed|succeeded|completed)\b/i.test(o.reply) && run?.status !== "succeeded"),
  "Chat does not elevate one test to universal qualification or misreport the actual test status.");
  return c.result();
}
export const integratorSkillStudioCases = [integratorDefinition("skills", "skills.studio-test", async ctx => {
  const worker = await fixtureWorker(ctx);
  const skill = await ctx.input.api.post<CompanySkillDetail>(`/api/companies/${ctx.input.fixtures.company.id}/skills`, { name: "Accessibility review", slug: "accessibility-review", markdown: studioMarkdown });
  const input = await ctx.input.api.post<CompanySkillTestInput>(`${root(ctx, skill.id)}/test-inputs`, { name: "Sample landing page", content: studioPageInput });
  const p = await project(ctx, "Launch", { description: `Our writable accessibility skill ${skill.id} has saved Studio input "Sample landing page" (${input.id}), containing synthetic HTML only. Morgan (${worker.id}) is the eligible test runner. Test the existing saved input without browsing unrelated pages.` });
  const selected = await saveSkillConversationContext(ctx, { projectId: p.id, description: `Selected writable skill: ${skill.name} (${skill.id}). Selected saved Studio input: ${input.name} (${input.id}), containing the synthetic landing-page HTML. Morgan (${worker.id}) is the eligible test runner.` });
  return { skill: await ctx.input.api.get<CompanySkillDetail>(root(ctx, skill.id)), input, worker: { id: worker.id }, project: p, factualContextAttachment: selected.factualContextAttachment };
}, observeStudio, gradeIntegratorSkillStudio, async (ctx, state, value) => {
  const o = studioObservation(value); const run = o?.studioRuns[0]; if (!o || !run) throw new Error("No actual Studio test to inspect");
  const source = ctx.input.page.url();
  await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/skills/studio/${(state.skill as CompanySkillDetail).id}?run=${run.id}`, ctx.input.api.baseURL).href);
  await expect(ctx.input.page.getByText("Output snapshot", { exact: true })).toBeVisible();
  await expect(ctx.input.page.getByText(/trial-email|email (?:input|field)/i).first()).toBeVisible();
  await ctx.input.evidence("chat-skill-studio-visible-result.json", { skillId: o.skill.id, testRunId: run.id, status: run.status, issueId: run.issueId, interactions: run.interactions, url: ctx.input.page.url() });
  await ctx.input.page.goto(source); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
}, { authentication: "human-session", queryAttachments: factualContextQueryAttachment("skill-context.md"), sourceFiles: ["chat-catalog-domains/integrator-skill-studio.ts", "chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-scenarios/skills.yaml"],
  expectedRunCount: 2, attemptTimeoutMs: 540_000,
  async act(ctx, state) {
    await pollUntil({ label: "actual bounded skill Studio output", deadlineAt: Date.now() + 240_000, intervalMs: 1000,
      load: () => observeStudio(ctx, state), accept: o => o.studioRuns.length === 1 && o.studioRuns[0]?.status === "succeeded" && o.runs.length === 2 && o.runs.every(run => run.status === "succeeded"),
      reject: o => o.studioRuns.length > 1 || o.runs.length > 2 ? "Studio test exceeded its declared one-test execution bound" : o.studioRuns.some(run => run.status === "failed" || run.status === "cancelled") ? "Studio genuinely failed or was cancelled; retain actual failure evidence rather than substitute a successful output" : undefined });
  },
})];
