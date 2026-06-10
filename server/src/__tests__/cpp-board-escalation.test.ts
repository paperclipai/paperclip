import { describe, expect, it } from "vitest";
import {
  buildCppBoardEscalationContext,
  extractBoardAccessRecommendationFingerprint,
  findLatestOverrideComment,
  optionViolatesBindingConstraints,
  shouldSuppressDuplicateBoardAccessRecommendation,
} from "../services/cpp-board-escalation.js";

describe("CPP board escalation sweep context", () => {
  it("detects latest non-sweep Nox/Cameron override comments before autonomous recommendations", () => {
    const override = findLatestOverrideComment([
      {
        id: "sweep-comment",
        issueId: "nox-785",
        authorAgentId: "nox-clone",
        createdAt: "2026-05-21T08:27:02.418Z",
        body: "Autonomous interaction decision for NOX-785: choose `clerk_replacement`. API returned `403 Board access required`.",
      },
      {
        id: "nox-override",
        issueId: "nox-785",
        authorAgentId: "nox",
        createdAt: "2026-05-21T08:12:27.268Z",
        body: "**Override - Nox board recommendation stands at `accept_attempted_e2e`.** The hourly sweep flipped to `clerk_replacement`, but do not dispatch Clerk replacement.",
      },
    ]);

    expect(override?.commentId).toBe("nox-override");
    expect(override?.optionId).toBe("accept_attempted_e2e");
    expect(override?.bodyExcerpt).toContain("Nox board recommendation stands");
  });

  it("treats parent Constraints / Risks and Review Gate as binding and rejects new Clerk e2e scope", () => {
    const context = buildCppBoardEscalationContext({
      issues: [
        {
          id: "nox-3992",
          identifier: "NOX-3992",
          title: "ESCALATION: board-answer NOX-785 e2e proof path",
          description: [
            "**Constraints / Risks:**",
            "No Cameron DM dispatch. Do not dispatch a new Clerk e2e feature from this escalation unless Cameron explicitly accepts that scope.",
            "",
            "**Review Gate:**",
            "Nox must review any board-answer change before closure.",
          ].join("\n"),
        },
      ],
      comments: [],
    });

    expect(context?.bindingContexts[0]?.source).toBe("NOX-3992");
    expect(context?.bindingContexts[0]?.constraints).toContain("Do not dispatch a new Clerk e2e feature");
    expect(context?.bannedOptions).toEqual([
      {
        optionId: "clerk_replacement",
        reason: "clerk_replacement maps onto banned new Clerk e2e/replacement scope in NOX-3992",
      },
    ]);

    expect(optionViolatesBindingConstraints({
      optionId: "accept_attempted_e2e",
      optionDescription: "Accept the attempted historical e2e proof and close the board gate",
      bindingContexts: context?.bindingContexts ?? [],
    }).rejected).toBe(false);
  });

  it("fingerprints and suppresses unchanged duplicate Board access escalation recommendations", () => {
    const body = [
      "ESCALATION: NOX-785 board-answer blocker.",
      "The API returned `403 Board access required`.",
      "Decision required: resolve interaction f20b5a0f-7edc-402b-ba69-ff007928e01e with option `accept_attempted_e2e`.",
    ].join("\n");

    expect(extractBoardAccessRecommendationFingerprint(body)).toEqual({
      interactionId: "f20b5a0f-7edc-402b-ba69-ff007928e01e",
      optionId: "accept_attempted_e2e",
    });

    expect(shouldSuppressDuplicateBoardAccessRecommendation(body, [
      {
        id: "previous-same-state",
        issueId: "nox-3992",
        createdAt: "2026-05-21T08:42:59.538Z",
        body,
      },
    ])).toBe(true);

    expect(shouldSuppressDuplicateBoardAccessRecommendation(body, [
      {
        id: "previous-different-state",
        issueId: "nox-3992",
        createdAt: "2026-05-21T08:42:59.538Z",
        body: body.replace("accept_attempted_e2e", "clerk_replacement"),
      },
    ])).toBe(false);
  });
});
