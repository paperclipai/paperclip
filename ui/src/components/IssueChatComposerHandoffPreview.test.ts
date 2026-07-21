import { describe, expect, it } from "vitest";
import { computeComposerHandoffPreview } from "../lib/interrupt-handoff";
import { shouldRenderComposerHandoffPreview } from "./IssueChatThread";

describe("shouldRenderComposerHandoffPreview", () => {
  it("skips the spacer wrapper when the preview is empty", () => {
    const preview = computeComposerHandoffPreview({
      reassignTarget: "agent:agent-claude",
      currentAssigneeValue: "agent:agent-claude",
      hasActiveRun: true,
      bodyHasAgentMention: false,
      plainNameCandidate: null,
    });

    expect(preview.kind).toBe("none");
    expect(shouldRenderComposerHandoffPreview("Wake Claude", preview)).toBe(false);
  });

  it("renders the spacer wrapper only when body text and a visible preview are present", () => {
    const preview = computeComposerHandoffPreview({
      reassignTarget: "agent:agent-qa",
      currentAssigneeValue: "agent:agent-claude",
      hasActiveRun: true,
      bodyHasAgentMention: false,
      plainNameCandidate: null,
    });

    expect(preview.kind).not.toBe("none");
    expect(shouldRenderComposerHandoffPreview("Wake QA", preview)).toBe(true);
    expect(shouldRenderComposerHandoffPreview("   ", preview)).toBe(false);
  });
});
