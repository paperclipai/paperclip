import { describe, expect, it } from "vitest";
import { deriveResponsibleUser } from "./issue-attribution.js";

describe("deriveResponsibleUser", () => {
  it("prefers an explicit responsible user", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: "user-responsible",
        createdByUserId: "user-creator",
      }),
    ).toEqual({
      userId: "user-responsible",
      source: "explicit",
      isAutoDerived: false,
    });
  });

  it("falls back to the creator user as an auto-derived responsible user", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: null,
        createdByUserId: "user-creator",
      }),
    ).toEqual({
      userId: "user-creator",
      source: "creator",
      isAutoDerived: true,
    });
  });

  it("returns none when no human is available", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: null,
        createdByUserId: null,
      }),
    ).toEqual({
      userId: null,
      source: "none",
      isAutoDerived: false,
    });
  });
});
