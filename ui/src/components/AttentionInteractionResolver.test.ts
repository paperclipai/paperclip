import { describe, expect, it } from "vitest";
import {
  failedSecretProposalInteraction,
  pendingSecretProposalInteraction,
} from "../fixtures/issueThreadInteractionFixtures";
import { replaceResolvedInteraction } from "./AttentionInteractionResolver";

describe("replaceResolvedInteraction", () => {
  it("immediately replaces a pending secret proposal with its stitched failure receipt", () => {
    const resolved = {
      ...failedSecretProposalInteraction,
      id: pendingSecretProposalInteraction.id,
    };

    const next = replaceResolvedInteraction([pendingSecretProposalInteraction], resolved);

    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe("accepted");
    expect(next[0]?.kind).toBe("request_confirmation");
    if (next[0]?.kind === "request_confirmation") {
      expect(next[0].result?.secretProposal).toMatchObject({
        status: "failed",
        errorCode: "binding_snapshot_stale",
      });
    }
  });

  it("retains the stitched receipt when the interaction cache was empty", () => {
    expect(replaceResolvedInteraction(undefined, failedSecretProposalInteraction)).toEqual([
      failedSecretProposalInteraction,
    ]);
  });
});
