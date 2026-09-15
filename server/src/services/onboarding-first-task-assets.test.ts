import { describe, expect, it } from "vitest";
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
  it("assembles the brief with the confirmation proposal when the toggle is off", async () => {
    const brief = await buildOnboardingFirstTaskBrief({ usePlanProposal: false });
    expect(brief).toContain("This is the user's first task in Paperclip.");
    // Step 1 branches on the opening card's two option ids.
    expect(brief).toContain("Take the path the user picked.");
    expect(brief).toContain(`\`${ONBOARDING_FIRST_TASK_OPENING_INTERVIEW_OPTION_ID}\` →`);
    expect(brief).toContain(`\`${ONBOARDING_FIRST_TASK_OPENING_TASK_OPTION_ID}\` →`);
    // The confirmation form is inlined at the {{proposalStep}} slot.
    expect(brief).toContain("post ONE request_confirmation that says, in a few lines");
    expect(brief).not.toContain("{{proposalStep}}");
    // The plan-form-only wording must not appear.
    expect(brief).not.toContain("treat it like the plan path");
  });

  it("assembles the brief with the plan proposal when the toggle is on", async () => {
    const brief = await buildOnboardingFirstTaskBrief({ usePlanProposal: true });
    expect(brief).toContain("treat it like the plan path");
    expect(brief).not.toContain("post ONE request_confirmation that says, in a few lines");
    expect(brief).not.toContain("{{proposalStep}}");
  });
});

describe("chief-of-staff persona", () => {
  it("renders the persona with placeholders filled", async () => {
    const persona = await renderChiefOfStaffPersona({
      agentName: "Ada",
      organizationName: "Acme",
    });
    expect(persona).toContain("You are Ada, chief of staff for Acme.");
    expect(persona).toContain("# Hiring and delegation");
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
