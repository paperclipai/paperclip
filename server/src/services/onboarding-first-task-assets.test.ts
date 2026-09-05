import { describe, expect, it } from "vitest";
import {
  buildOnboardingFirstTaskBrief,
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
    expect(greeting).toContain("What would you like to do?");
  });
});

describe("buildOnboardingFirstTaskBrief", () => {
  it("assembles the brief with the confirmation proposal when the toggle is off", async () => {
    const brief = await buildOnboardingFirstTaskBrief({ usePlanProposal: false });
    expect(brief).toContain("This is the user's first task in Paperclip.");
    expect(brief).toContain("Always ask first.");
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
