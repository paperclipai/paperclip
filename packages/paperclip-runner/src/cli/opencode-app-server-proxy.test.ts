import { describe, expect, it } from "vitest";

import { openCodeProxyTaskEnvelope } from "./opencode-proxy-task-envelope.js";

describe("OpenCode runnerd proxy task envelope", () => {
  it("uses the durable completion-contract binding instead of a demo revision", () => {
    expect(openCodeProxyTaskEnvelope({
      baseInstructions: "Complete only this task.",
      completionContract: {
        revision: "17",
        criterionIds: ["objective", "verification"],
      },
    })).toMatchObject({
      completionContract: {
        revision: "17",
        criteria: [
          { id: "objective" },
          { id: "verification" },
        ],
      },
    });
  });
});
