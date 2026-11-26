import { describe, expect, it } from "vitest";
import {
  gradeProviderChoice,
  gradeProviderOutcome,
} from "./connection-routing-evidence.js";
const pending = [
  {
    id: "question",
    kind: "ask_user_questions",
    status: "pending",
    payload: {
      questions: [
        {
          id: "connection-provider:hubspot",
          prompt:
            "Connect HubSpot through an external service? These services handle the connection and requests to HubSpot. Connecting a provider does not yet authorize HubSpot.",
          helpText: "",
          selectionMode: "single",
          options: [
            "via:composio:hubspot",
            "via:arcade:hubspot",
            "via:zapier:hubspot",
            "none",
          ].map((id) => ({ id })),
        },
      ],
    },
  },
];
describe("external-provider evidence oracle", () => {
  it("requires disclosure, exact ordering, None, and no early calls", () => {
    expect(gradeProviderChoice(pending, 0).interaction.id).toBe("question");
    expect(() => gradeProviderChoice(pending, 1)).toThrow("before");
    expect(() => gradeProviderChoice([], 0)).toThrow();
    const wrong = structuredClone(pending);
    wrong[0]!.payload.questions[0]!.options.reverse();
    expect(() => gradeProviderChoice(wrong, 0)).toThrow("ordering");
    wrong[0]!.payload.questions[0]!.prompt = "Connect HubSpot?";
    wrong[0]!.payload.questions[0]!.helpText = "";
    expect(() => gradeProviderChoice(wrong, 0)).toThrow("disclosure");
  });
  it("rejects fabricated success, duplicate questions, and execution after None", () => {
    const input = {
      rows: [
        {
          id: "question",
          kind: "ask_user_questions",
          status: "answered",
          result: {
            answers: [
              {
                questionId: "connection-provider:hubspot",
                optionIds: ["via:arcade:hubspot"],
              },
            ],
          },
        },
      ],
      decisionId: "question",
      selected: "via:arcade:hubspot",
      calls: 1,
      response: "Ada, MARKER",
      marker: "MARKER",
      sameConnections: true,
    };
    expect(gradeProviderOutcome(input).every((check) => check.passed)).toBe(
      true,
    );
    expect(
      gradeProviderOutcome({ ...input, calls: 0 }).every(
        (check) => check.passed,
      ),
    ).toBe(false);
    expect(
      gradeProviderOutcome({
        ...input,
        rows: [...input.rows, ...input.rows],
      }).every((check) => check.passed),
    ).toBe(false);
    input.selected = "none";
    input.rows[0]!.result.answers[0]!.optionIds = ["none"];
    expect(gradeProviderOutcome(input).every((check) => check.passed)).toBe(
      false,
    );
    expect(
      gradeProviderOutcome({
        ...input,
        calls: 0,
        response: "Could not retrieve contacts",
      }).every((check) => check.passed),
    ).toBe(true);
  });
});
