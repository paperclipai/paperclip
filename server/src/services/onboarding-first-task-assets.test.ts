import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "@paperclipai/paperclip-runner";
import {
  ONBOARDING_FIRST_TASK_OPENING_INTERVIEW_OPTION_ID,
  ONBOARDING_FIRST_TASK_OPENING_QUESTION_ID,
  ONBOARDING_FIRST_TASK_OPENING_TASK_OPTION_ID,
  buildOnboardingFirstTaskBrief,
  buildOnboardingFirstTaskOpeningQuestion,
  buildOnboardingFirstAgentInstructionsBundle,
  fillFirstTaskPlaceholders,
  renderChiefOfStaffPersona,
  renderOnboardingFirstTaskGreeting,
} from "./onboarding-first-task-assets.js";

describe("fillFirstTaskPlaceholders", () => {
  it("fills the name and organization when present", () => {
    const out = fillFirstTaskPlaceholders(
      "I'm {{agentName}}, chief of staff for {{organizationName}}.",
      { agentName: "Ada", organizationName: "Acme" },
    );
    expect(out).toBe("I'm Ada, chief of staff for Acme.");
  });

  it("drops the name and its trailing separator when no name is set", () => {
    const out = fillFirstTaskPlaceholders("I'm {{agentName}}, your first agent teammate.", {
      agentName: null,
    });
    expect(out).toBe("I'm your first agent teammate.");
  });

  it("falls back to a generic organization label when missing", () => {
    const out = fillFirstTaskPlaceholders("for {{organizationName}}.", {});
    expect(out).toBe("for your organization.");
  });
});

describe("renderOnboardingFirstTaskGreeting", () => {
  it("renders the board-approved greeting with the agent name", async () => {
    const greeting = await renderOnboardingFirstTaskGreeting({ agentName: "Ada" });
    expect(greeting).toContain("Welcome to Paperclip! I'm Ada, your first agent teammate.");
    // The "what would you like to do" question moved onto the opening card.
    expect(greeting).not.toContain("What would you like to do?");
  });
});

describe("buildOnboardingFirstTaskOpeningQuestion", () => {
  it("builds the two-option opening card with a free-text task option", async () => {
    const payload = await buildOnboardingFirstTaskOpeningQuestion();
    expect(payload.version).toBe(1);
    expect(payload.supersedeOnUserComment).toBe(true);
    expect(payload.submitLabel).toBe("Continue");
    expect(payload.questions).toHaveLength(1);
    const [question] = payload.questions;
    expect(question.id).toBe(ONBOARDING_FIRST_TASK_OPENING_QUESTION_ID);
    expect(question.selectionMode).toBe("single");
    expect(question.required).toBe(true);
    expect(question.prompt).toBe("What would you like to do?");
    expect(question.options.map((option) => option.id)).toEqual([
      ONBOARDING_FIRST_TASK_OPENING_INTERVIEW_OPTION_ID,
      ONBOARDING_FIRST_TASK_OPENING_TASK_OPTION_ID,
    ]);
    expect(question.options[0].label).toBe(
      "Interview me and propose a plan and an agent team to execute it.",
    );
    expect(question.options[0].freeText).toBeUndefined();
    expect(question.options[1].label).toBe("I have a task in mind");
    expect(question.options[1].freeText).toBe(true);
  });
});

describe("buildOnboardingFirstTaskBrief", () => {
  it.each([
    { usePlanProposal: false, mode: "confirmation" },
    { usePlanProposal: true, mode: "plan" },
  ])("invokes the skill with $mode mode without inlining the policy", async ({ usePlanProposal, mode }) => {
    const brief = await buildOnboardingFirstTaskBrief({ usePlanProposal });
    expect(brief).toContain("Use the `first-task` skill (/first-task)");
    expect(brief).toContain("Read its SKILL.md");
    expect(brief).toContain("subsequent wakes of this task");
    expect(brief).toContain(`Single-task proposal mode: \`${mode}\`.`);
    expect(brief).not.toContain("{{");
    expect(brief).not.toContain("Take the path the user picked.");
    expect(brief).not.toContain("request_confirmation");
    expect(brief).not.toContain("request_checkbox_confirmation");
  });
});

describe("first-task proposal mode policy", () => {
  it("maps both persisted brief modes to their proposal forms", async () => {
    const skill = await readFile(new URL("../onboarding-assets/first-task/skills/first-task/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("`confirmation` means one `request_confirmation`");
    expect(skill).toContain("`plan` means save a short `plan` document");
    expect(skill).toContain("`request_checkbox_confirmation` targeting its saved revision");
    expect(skill).toContain("explicit plan requests regardless of the single-task proposal mode");
  });

  it("hands accepted file-producing child work to its own execution before reporting results", async () => {
    const skill = await readFile(new URL("../onboarding-assets/first-task/skills/first-task/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("If the accepted child work requires a file deliverable");
    expect(skill).toContain("self-contained child description");
    expect(skill).toContain("requested filenames");
    expect(skill).toContain("child's own Paperclip execution");
    expect(skill).toContain("even when the child is assigned to yourself");
    expect(skill).toContain("Do not create or register that file from the onboarding run");
    expect(skill).toContain("`register_deliverable` is bound to its current task");
    expect(skill).toContain("preserve existing blocker IDs");
    expect(skill).toContain("`set_dependencies`");
    expect(skill).toContain("`paperclip_block`");
    expect(skill).toContain("`blockedByIssueIds`");
    expect(skill).toContain("End the turn so the child can execute");
    expect(skill).toContain("Do not poll for its result");
    expect(skill).toContain("verify the saved child document and retrievable file");
    expect(skill).toContain("actual child task and download links");
  });

  it("ships native child handoff arguments that let the child run before its waiting parent", async () => {
    const skill = await readFile(new URL("../onboarding-assets/first-task/skills/first-task/SKILL.md", import.meta.url), "utf8");
    const recipe = [...skill.matchAll(/```json\s+([\s\S]*?)```/g)]
      .map((match) => JSON.parse(match[1]!) as Record<string, Record<string, unknown>>)
      .find((value) => value.createTask && value.setDependencies);
    if (!recipe) throw new Error("Shipped first-task skill is missing the native child handoff recipe");
    expect(Object.keys(recipe).sort()).toEqual(["createTask", "setDependencies"]);
    expect(recipe.createTask).toEqual({
      idempotencyKey: "first-task-child:<proposal-id>",
      title: "<child-title>",
      description: "<approved-child-description>",
      assigneeActorId: "<self-agent-id>",
      status: "todo",
      blockedByTaskIds: [],
    });
    expect(recipe.setDependencies).toEqual({
      idempotencyKey: "first-task-wait:<proposal-id>",
      blockedByTaskIds: ["<existing-blocker-id>", "<child-task-id>"],
    });

    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
    for (const [operationId, input] of [["create_task", recipe.createTask], ["set_dependencies", recipe.setDependencies]] as const) {
      const descriptor = CAPABILITY_SEMANTIC_TOOL_CATALOG.find((tool) => tool.operationId === operationId);
      if (!descriptor) throw new Error(`Missing native tool descriptor: ${operationId}`);
      const validate = ajv.compile(descriptor.inputSchema);
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...input, notAToolArgument: true })).toBe(false);
    }
    expect(skill).toContain("Copy required input payloads verbatim");
    expect(skill).toContain("encoded bytes, nonces, constraints, and requested filenames");
    expect(skill).toContain('Do not leave references such as "provided above"');
    expect(skill).toContain("Parent-child linkage is not a dependency");
  });

  it("keeps plan-only authorization and document-only child execution distinct from file handoff", async () => {
    const skill = await readFile(new URL("../onboarding-assets/first-task/skills/first-task/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("For a plan-only request, retain the accepted plan on this task");
    expect(skill).toContain("Do not start its implementation or hire the proposed team without authorization");
    expect(skill).toContain("Create exactly one child linked to this onboarding task");
    expect(skill).toContain("For document-only child work, you may execute it directly");
    expect(skill).toContain("Save the finished output as a document on the child task and mark that child done");
    expect(skill).toContain("On later wakes, continue that same child instead of creating another");
  });
});

describe("chief-of-staff persona", () => {
  it("renders the persona with placeholders filled", async () => {
    const persona = await renderChiefOfStaffPersona({
      agentName: "Ada",
      organizationName: "Acme",
    });
    expect(persona).toContain("You are Ada, chief of staff for Acme.");
    expect(persona).not.toContain("{{agentName}}");
    expect(persona).not.toContain("{{organizationName}}");
  });

  it("returns an AGENTS.md-keyed bundle for the first agent", async () => {
    const bundle = await buildOnboardingFirstAgentInstructionsBundle({
      agentName: "Ada",
      organizationName: "Acme",
    });
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files).toEqual({
      "AGENTS.md": await renderChiefOfStaffPersona({ agentName: "Ada", organizationName: "Acme" }),
    });
  });
});
