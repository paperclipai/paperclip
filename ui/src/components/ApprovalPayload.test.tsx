// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });

  it("uses strategic recommendations when no explicit title is present", () => {
    expect(
      approvalLabel("approve_ceo_strategy", {
        recommendation: "Run a limited pricing probe before committing to a full launch.",
      }),
    ).toBe("CEO Strategy: Run a limited pricing probe before committing to a full launch.");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });

  it("renders strategist decision cards without exposing raw payload keys", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="approve_ceo_strategy"
          payload={{
            recommendation: "Run a limited pricing probe before committing to a full launch.",
            why: [
              "Current evidence is directionally positive but still inferred from a small sample.",
              "A reversible probe will sharpen pricing confidence before broader rollout.",
            ],
            topRisk: "A full launch now could lock the team into the wrong pricing model.",
            confidence: "medium",
            nextStepMode: "probe",
            nextStep: "Run a two-week pricing test on 10% of qualified traffic.",
            alternatives: [
              "Ship the full pricing change immediately.",
              "Delay all pricing work until the next quarter.",
            ],
            evidence: [
              "Win-rate improved in the last five sales calls.",
              "Self-serve conversion remains unverified.",
            ],
            changeMyMind: "If the probe does not improve paid conversion, keep the existing pricing.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Recommended Direction");
    expect(container.textContent).toContain("Run a limited pricing probe before committing to a full launch.");
    expect(container.textContent).toContain("Why This Direction");
    expect(container.textContent).toContain("Top Risk");
    expect(container.textContent).toContain("Confidence");
    expect(container.textContent).toContain("Medium");
    expect(container.textContent).toContain("Next Step");
    expect(container.textContent).toContain("Run Probe");
    expect(container.textContent).toContain("Alternatives Considered");
    expect(container.textContent).toContain("Evidence");
    expect(container.textContent).toContain("What Would Change My Mind");
    expect(container.textContent).not.toContain("\"recommendation\"");
    expect(container.textContent).not.toContain("\"nextStepMode\"");

    act(() => {
      root.unmount();
    });
  });
});
