import { describe, expect, it } from "vitest";
import { attentionAudienceReasonText } from "./attention-audience.js";

describe("attention audience reason text", () => {
  it("tells the default decision owner why the card came to them", () => {
    expect(attentionAudienceReasonText("escalation_owner")).toBe("You are the default decision owner");
  });

  it("names the project and budget escalation owners", () => {
    expect(attentionAudienceReasonText("project_owner")).toBe("You own this project's decisions");
    expect(attentionAudienceReasonText("budget_owner")).toBe("You own budget escalation");
  });

  it("has no line for an unaddressed card", () => {
    expect(attentionAudienceReasonText("none")).toBeNull();
  });
});
