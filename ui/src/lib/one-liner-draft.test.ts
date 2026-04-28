import { describe, expect, it } from "vitest";
import { buildOneLinerTaskDescription, parseOneLinerInput } from "./one-liner-draft";

describe("parseOneLinerInput", () => {
  it("parses explicit one-liner fields into a structured draft", () => {
    const draft = parseOneLinerInput(
      [
        "task: Prepare investor update",
        "todo: Draft finance slide",
        "deliverable: Investor memo",
        "price: 250,000",
        "daily: aligned scope with finance and CEO",
        "mode: collab",
        "capacity: 3",
      ].join("\n"),
    );

    expect(draft).toEqual(
      expect.objectContaining({
        taskTitle: "Prepare investor update",
        todoTitle: "Draft finance slide",
        deliverableTitle: "Investor memo",
        basePrice: 250000,
        dailyLog: "aligned scope with finance and CEO",
        taskMode: "collab",
        capacity: 3,
      }),
    );
    expect(draft.warnings).toHaveLength(0);
  });

  it("falls back to the first freeform clause as the task title", () => {
    const draft = parseOneLinerInput("Prepare launch checklist; waiting on deliverable naming");

    expect(draft.taskTitle).toBe("Prepare launch checklist");
    expect(draft.dailyLog).toBe("waiting on deliverable naming");
    expect(draft.warnings).toEqual(
      expect.arrayContaining([
        "Deliverable title is still missing.",
        "Base price is still missing.",
      ]),
    );
  });

  it("builds a structured task description from the reviewed draft", () => {
    const description = buildOneLinerTaskDescription({
      rawInput: "task: Prepare launch checklist",
      taskTitle: "Prepare launch checklist",
      todoTitle: "Draft partner follow-up",
      dailyLog: "Kickoff complete",
      deliverableTitle: "Launch checklist",
      basePrice: 180000,
      taskMode: "solo",
      capacity: 1,
      warnings: [],
    });

    expect(description).toContain("Daily log");
    expect(description).toContain("Todo intent");
    expect(description).toContain("Source input");
  });
});
