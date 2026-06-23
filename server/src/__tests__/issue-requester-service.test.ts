import { describe, expect, it } from "vitest";
import { resolveRootHumanRequesterFromIssuePath } from "../services/issue-requester.js";

describe("issue requester resolution", () => {
  it("resolves the rootmost human requester across agent-created child chains", () => {
    const requester = resolveRootHumanRequesterFromIssuePath({
      issue: {
        id: "grandchild",
        identifier: "PAP-3",
        title: "Agent grandchild",
        createdByUserId: null,
      },
      ancestors: [
        {
          id: "child",
          identifier: "PAP-2",
          title: "Agent child",
          createdByUserId: null,
        },
        {
          id: "root",
          identifier: "PAP-1",
          title: "Human root",
          createdByUserId: "  jonas-user  ",
        },
      ],
    });

    expect(requester).toEqual({
      userId: "jonas-user",
      issueId: "root",
      identifier: "PAP-1",
      title: "Human root",
      source: "ancestor",
    });
  });

  it("falls back to the current issue when no ancestor has a human creator", () => {
    const requester = resolveRootHumanRequesterFromIssuePath({
      issue: {
        id: "current",
        identifier: "PAP-4",
        title: "Human current",
        createdByUserId: "thomas-user",
      },
      ancestors: [
        {
          id: "parent",
          identifier: "PAP-3",
          title: "Agent parent",
          createdByUserId: null,
        },
      ],
    });

    expect(requester).toEqual({
      userId: "thomas-user",
      issueId: "current",
      identifier: "PAP-4",
      title: "Human current",
      source: "current_issue",
    });
  });
});
