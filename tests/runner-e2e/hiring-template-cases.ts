import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerProfileFixture, RunnerTaskFixture } from "./types.js";

export const HIRING_TEMPLATE_GRADER_VERSION = "paperclip.hiring-templates.v1";
export const HIRING_TEMPLATE_SKILL_KEY = "paperclipai/paperclip/paperclip-create-agent";
export const HIRING_TEMPLATE_READ_FILES = [
  "SKILL.md",
  "references/agent-instruction-templates.md",
  "references/draft-review-checklist.md",
  "references/agents/coder.md",
] as const;
export const HIRING_TEMPLATE_SOURCE_FILES = [
  "server/src/services/default-agent-instructions.ts",
  "server/src/onboarding-assets/default/AGENTS.md",
  ...HIRING_TEMPLATE_READ_FILES.map(file => `skills/paperclip-create-agent/${file}`),
  "skills/paperclip-create-agent/references/baseline-role-guide.md",
] as const;
export const hiringTemplateDefinitionDigest = createHash("sha256").update(
  ["cases", "scoring", "flow"].map(part => readFileSync(new URL(`./hiring-template-${part}.ts`, import.meta.url), "utf8")).join("\n"),
).digest("hex");

export function hiringTemplateProfile(profile: RunnerProfileFixture): RunnerProfileFixture {
  return {
    ...profile,
    buildAgent(input) {
      const { instructionsBundle: _fixtureInstructions, ...payload } = profile.buildAgent(input);
      return { ...payload, name: `Hiring Lead ${input.executionId}`, role: "ceo", title: "CEO" };
    },
  };
}

export const hiringTemplateInputs = ["  Launch Queue!! ", "API__Key Rotation", "Mixed CASE / 42", "---Already--Ready---"] as const;
export function hiringTemplateScenario(nonce: string, projectName: string) {
  const marker = `HIRE${nonce.replace(/[^a-zA-Z0-9]/g, "")}`;
  const hireName = `Casey Coder ${nonce}`;
  return {
    marker, hireName, inputs: hiringTemplateInputs,
    initialPrompt: [
      `Use the paperclip-create-agent skill to hire exactly one coding teammate named ${hireName}, reporting to you, with your native runner, model, and available AI connection.`,
      "Before hiring, read that skill's SKILL.md, references/agent-instruction-templates.md, references/draft-review-checklist.md, and references/agents/coder.md. Use the AGENTS.md example from that coder reference as the teammate's managed instructions, filling all agentName, companyName, managerTitle, and issuePrefix placeholders from this hire, company, your actual title, and the company issue prefix. Keep skills and reporting information in their configuration.",
      `Have that coder prepare a JSON test fixture for a label normalizer in one assigned task in ${projectName}. Save the fixture as a Paperclip document with an object containing reference: ${JSON.stringify(marker)} and entries, an ordered array of objects with input and value. Inputs: ${JSON.stringify(hiringTemplateInputs)}.`,
      "For each value, trim its input, lowercase it, replace each sequence outside ASCII a-z and 0-9 with one hyphen, then trim leading and trailing hyphens. Link the task here and let the coder complete it.",
    ].join("\n\n"),
    reusePrompt: (identifier: string) => `Have the existing ${hireName} prepare a second saved JSON fixture in one new task in ${projectName}, assigned to that same coder. Use the inputs and normalization rule from ${identifier}, but use underscores instead of hyphens for the value separators and trim leading and trailing underscores. Use reference: ${JSON.stringify(`REUSE${marker}`)}. Include the original fixture in the handoff. Preserve the original document and task, and let the coder complete the new task.`,
    statusPrompt: (first: string, second: string) => `Briefly report the recorded owner and status of ${first} and ${second}. Just report; do not create or change work.`,
  };
}

export const hiringTemplateTasks: readonly RunnerTaskFixture[] = [{
  id: "hire-coder-template-reuse", label: "Hire with production templates and reuse the coder",
  groups: ["chat"], flow: "agent_chat", workMode: "standard", expectedRunCount: 5,
  attemptTimeoutMs: { local: 15 * 60_000, daytona: 15 * 60_000 },
  expectedTerminalState: { issue: "in_review", run: "succeeded" },
  buildTitle: nonce => `Production hiring templates ${nonce}`,
  buildPrompt: nonce => hiringTemplateScenario(nonce, "the selected project").initialPrompt,
  buildVisibleMarker: nonce => hiringTemplateScenario(nonce, "").marker,
  buildMatchers: () => [{ kind: "issue_status", expected: "in_review" }],
}];
