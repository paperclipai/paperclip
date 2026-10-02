import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
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
});

describe("chief-of-staff persona", () => {
  it("renders the persona with placeholders filled", async () => {
    const persona = await renderChiefOfStaffPersona({
      agentName: "Ada",
      organizationName: "Acme",
    });
    expect(persona).toContain("You are Ada, chief of staff for Acme.");
    expect(persona).toContain("# Working with the user");
    expect(persona).not.toContain("{{agentName}}");
    expect(persona).not.toContain("{{organizationName}}");
  });

  it("returns an AGENTS.md-keyed bundle for the first agent", async () => {
    const bundle = await buildOnboardingFirstAgentInstructionsBundle({
      agentName: "Ada",
      organizationName: "Acme",
    });
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files["AGENTS.md"]).toContain("You are Ada, chief of staff for Acme.");
  });
});
