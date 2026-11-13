import { describe, expect, it } from "vitest";
import { collapsePendingConfirmationsToNewest } from "../services/attention-source-eligibility.js";

function confirmation(id: string, at: number, fields: {
  addresseeUserId?: string | null;
  addresseeAgentId?: string | null;
  payload?: unknown;
} = {}) {
  return { id, issueId: "task", kind: "request_confirmation", createdAt: new Date(at),
    payload: { version: 1, prompt: "Approve?" }, ...fields };
}

describe("pending confirmation selection", () => {
  it("replaces only an ordinary confirmation for the same recipient", () => {
    const rows = [
      confirmation("old", 0), confirmation("new", 1),
      confirmation("scott", 2, { addresseeUserId: "scott" }),
      confirmation("dotta", 3, { addresseeUserId: "dotta" }),
      confirmation("agent", 4, { addresseeAgentId: "agent" }),
    ];
    expect(collapsePendingConfirmationsToNewest(rows).map(row => row.id))
      .toEqual(["new", "scott", "dotta", "agent"]);
  });

  it.each(["toolAction", "secretProposal", "connectionAuthorization", "qualityReview"])(
    "keeps each pending %s gate independent of other requests", (key) => {
      const rows = [confirmation("ordinary", 0),
        confirmation("gate-a", 1, { payload: { [key]: { id: "a" } } }),
        confirmation("gate-b", 2, { payload: { [key]: { id: "b" } } })];
      expect(collapsePendingConfirmationsToNewest(rows).map(row => row.id))
        .toEqual(["ordinary", "gate-a", "gate-b"]);
    },
  );
});
