import { describe, expect, it } from "vitest";
import { composeCeoInstructions } from "./ceo-instructions";

describe("composeCeoInstructions", () => {
  it("includes the board conversation report and options contract", () => {
    const instructions = composeCeoInstructions({
      companyName: "Acme AI",
      companyGoal: "Ship useful agent workflows",
      growPath: false,
      growWorkflows: "",
      growPainPoints: "",
      growAutomate: "",
      q1: "We build workflow tools.",
      q2: "Operations teams.",
      q3: "Manual coordination.",
      q4: "Faster execution.",
    });

    expect(instructions).toContain("# Board conversation contract");
    expect(instructions).toContain("answer as the real CEO");
    expect(instructions).toContain("Report");
    expect(instructions).toContain("What I checked");
    expect(instructions).toContain("Recommendation");
    expect(instructions).toContain("Options");
    expect(instructions).toContain("suggest_tasks");
    expect(instructions).toContain("request_confirmation");
    expect(instructions).toContain("ask_user_questions");
    expect(instructions).toContain("Keep the CEO boundary intact");
    expect(instructions).toContain("I will check");
  });
});
