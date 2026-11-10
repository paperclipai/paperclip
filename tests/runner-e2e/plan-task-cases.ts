import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerProfileFixture, RunnerTaskFixture } from "./types.js";

export const PLAN_VARIANTS = ["current", "short", "disabled"] as const;
export const PLAN_CASES = ["cohesive", "parallel", "dependency", "review"] as const;
export type PlanVariant = typeof PLAN_VARIANTS[number];
export type PlanCase = typeof PLAN_CASES[number];
export const PLAN_BUDGET_CENTS = 500;
export const PLAN_MAX_RUNS = 8;
export const PLAN_BASE_SHA = "72ff3a9f27e581a27acb49771e8658bbb0bbaa47";
export const PLAN_SKILLS = [
  { key: "paperclipai/paperclip/paperclip-converting-plans-to-tasks", current: "tests/runner-e2e/fixtures/plan-task-guidance/current-conversion.md", short: "skills/paperclip-converting-plans-to-tasks/SKILL.md" },
  { key: "paperclipai/bundled/paperclip-operations/task-planning", current: "tests/runner-e2e/fixtures/plan-task-guidance/current-planning.md", short: "packages/skills-catalog/catalog/bundled/paperclip-operations/task-planning/SKILL.md" },
] as const;
export const planHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const planDefinitionDigest = planHash([
  "plan-task-cases.ts", "plan-task-flow.ts", "plan-task-scoring.ts", "plan-task-skills.ts", "plan-task-ui.ts", "plan-task-exposure.ts",
  "fixtures/plan-task-guidance/current-conversion.md", "fixtures/plan-task-guidance/current-planning.md",
].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\0"));

export function parsePlanCase(id: string): { variant: PlanVariant; caseId: PlanCase } {
  const [variant, caseId, extra] = id.split("-");
  if (extra || !PLAN_VARIANTS.includes(variant as PlanVariant) || !PLAN_CASES.includes(caseId as PlanCase)) throw new Error(`Unknown plan-task case ${id}`);
  return { variant: variant as PlanVariant, caseId: caseId as PlanCase };
}

export function planScenario(caseId: PlanCase, nonce: string) {
  const marker = `PLAN${nonce.replace(/[^a-z0-9]/gi, "")}`;
  const prompts: Record<PlanCase, string> = {
    cohesive: `Prepare a verified order summary from two units at 7 dollars each and three units at 5 dollars each. Save a document on this task with key result containing JSON with marker "${marker}", units (the summed quantity), and total (the calculated dollar amount). Check the arithmetic and finish the requested work.`,
    parallel: `Prepare our launch packet. Alex Metrics is accountable for independently calculating and signing off the seat total from groups of 11 and 13. Riley Copy is accountable for independently approving our Spanish welcome text, whose supplied source is "Hola, equipo". Each specialist must save their own signed result document on their work item: Alex uses fields marker "${marker}" and seats (the calculated total); Riley uses {"marker":"${marker}","welcome":"Hola, equipo"}. Their inputs are independent. Compile their actual saved approvals into this task's result document with fields marker "${marker}", seats and welcome and finish the packet.`,
    dependency: `Prepare the release receipt. Alex Metrics owns verifying the order: two units at 7 dollars plus three at 5 dollars. Alex must save a result document with fields marker "${marker}", units (the summed quantity), and total (the calculated dollar amount) on Alex's work item. Riley Copy owns release verification and must inspect that actual saved result after Alex completes it; Riley cannot perform release work before that prerequisite is complete. Riley's result document must contain fields marker "${marker}", releasedTotal (the verified dollar total), and sourceRevisionId (the actual revision ID of Alex's result). Deliver Riley's verified receipt as this task's result document and finish.`,
    review: `Obtain Riley Copy's independent audit of this supplied order proposal: two units at 7 dollars, three units at 5 dollars, proposed total 30 dollars. Riley must author a result document on Riley's review work item with fields marker "${marker}", verdict ("accept" or "reject"), correctTotal (the independently calculated dollar total), and difference (the absolute error in the proposal). The audit, including any adverse finding, is the complete requested deliverable; do not implement a correction. Report Riley's actual verdict in this task's result document with those same fields and finish.`,
  };
  return { marker, prompt: `Plan the work briefly, then carry it out. Execution is already authorized; no additional approval is requested. Choose how to organize the work. ${prompts[caseId]} Save every requested result document with key result and exactly the requested JSON fields. Documents may use a JSON code block. Link the final saved result in your response.` };
}

export function planTaskProfile(profile: RunnerProfileFixture): RunnerProfileFixture {
  return { ...profile, buildAgent(input) {
    const payload = profile.buildAgent(input);
    return { ...payload, name: `Operations Lead ${input.executionId}`, role: "general", title: "Operations Lead",
      adapterConfig: { ...(payload.adapterConfig as Record<string, unknown>), timeoutSec: 360 },
      budgetMonthlyCents: PLAN_BUDGET_CENTS, capabilities: "Completes operational requests and coordinates available specialists.",
      instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": "You coordinate a small operations team. Deliver accurate, verified work that meets the user's requirements." } } };
  } };
}

export const planTaskCases: readonly RunnerTaskFixture[] = PLAN_VARIANTS.flatMap(variant => PLAN_CASES.map(caseId => ({
  id: `${variant}-${caseId}`, label: `${variant} planning guidance: ${caseId}`, groups: [], workMode: "standard" as const,
  flow: "plan_task_guidance" as const, expectedRunCount: PLAN_MAX_RUNS, minimumExpectedRunCount: 1,
  automaticRetryPolicy: "single_attempt" as const, attemptTimeoutMs: { local: 12 * 60_000, daytona: 12 * 60_000 },
  expectedTerminalState: { issue: "done" as const, run: "succeeded" as const },
  buildTitle: (nonce: string) => `Planning ${caseId} ${nonce}`,
  buildPrompt: (nonce: string) => planScenario(caseId, nonce).prompt,
  buildVisibleMarker: (nonce: string) => planScenario(caseId, nonce).marker,
  buildMatchers: () => [],
})));
