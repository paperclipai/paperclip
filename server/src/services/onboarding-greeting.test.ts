import { describe, expect, it } from "vitest";
import { renderOnboardingGreeting } from "./onboarding-greeting.js";

describe("renderOnboardingGreeting", () => {
  it("introduces the agent by name as the user's first teammate", async () => {
    const greeting = await renderOnboardingGreeting({
      agentName: "Nova",
      organizationName: "Acme",
    });

    expect(greeting).toContain(
      "Welcome to Paperclip! I'm Nova, your first agent teammate.",
    );
    // No goal quote and no "give me one moment" — the agent is not about to run.
    expect(greeting).not.toContain("aiming for");
    expect(greeting).not.toContain("one moment");
    expect(greeting).toContain("What would you like to do?");
  });

  it("drops the name gracefully when no agent name is set", async () => {
    const greeting = await renderOnboardingGreeting({
      agentName: null,
      organizationName: "Acme",
    });

    expect(greeting).toContain(
      "Welcome to Paperclip! I'm your first agent teammate.",
    );
    expect(greeting).not.toContain("{{agentName}}");
  });

  it("trims whitespace/blank names to the no-name phrasing", async () => {
    const greeting = await renderOnboardingGreeting({ agentName: "   " });

    expect(greeting).toContain("I'm your first agent teammate.");
  });
});
