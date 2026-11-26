import { describe, expect, it } from "vitest";
import {
  RESPONSIBLE_USER_DENIAL_CODES,
  describeResponsibleUserDenial,
  isResponsibleUserDenialCode,
  responsibleUserLabel,
} from "./responsible-user-denial.js";

describe("isResponsibleUserDenialCode", () => {
  it("recognizes the two responsible-user denial codes", () => {
    expect(isResponsibleUserDenialCode("RESPONSIBLE_USER_UNAUTHORIZED")).toBe(true);
    expect(isResponsibleUserDenialCode("RESPONSIBLE_USER_UNAVAILABLE")).toBe(true);
  });

  it("rejects agent-lacks-permission and unrelated codes", () => {
    expect(isResponsibleUserDenialCode("access_denied")).toBe(false);
    expect(isResponsibleUserDenialCode("deny_missing_membership")).toBe(false);
    expect(isResponsibleUserDenialCode(null)).toBe(false);
    expect(isResponsibleUserDenialCode(undefined)).toBe(false);
  });

  it("covers every exported code", () => {
    for (const code of RESPONSIBLE_USER_DENIAL_CODES) {
      expect(isResponsibleUserDenialCode(code)).toBe(true);
    }
  });
});

describe("responsibleUserLabel", () => {
  it("uses the display name when present", () => {
    expect(responsibleUserLabel("Ada Lovelace")).toBe("Ada Lovelace");
  });

  it("falls back to a generic noun, never a raw id, when unknown", () => {
    expect(responsibleUserLabel(null)).toBe("the responsible user");
    expect(responsibleUserLabel(undefined)).toBe("the responsible user");
    expect(responsibleUserLabel("   ")).toBe("the responsible user");
  });
});

describe("describeResponsibleUserDenial", () => {
  it("distinguishes unauthorized (user lacks permission) from unavailable", () => {
    const unauthorized = describeResponsibleUserDenial("RESPONSIBLE_USER_UNAUTHORIZED");
    const unavailable = describeResponsibleUserDenial("RESPONSIBLE_USER_UNAVAILABLE");

    expect(unauthorized.tone).toBe("unauthorized");
    expect(unavailable.tone).toBe("unavailable");
    expect(unauthorized.title).not.toEqual(unavailable.title);
    expect(unauthorized.description).not.toEqual(unavailable.description);
  });

  it("names the responsible user in unauthorized copy when known", () => {
    const copy = describeResponsibleUserDenial("RESPONSIBLE_USER_UNAUTHORIZED", {
      userName: "Ada Lovelace",
    });
    expect(copy.description).toContain("Ada Lovelace");
    expect(copy.recommendedAction).toContain("Ada Lovelace");
  });

  it("uses generic phrasing when the responsible user name is unknown", () => {
    const copy = describeResponsibleUserDenial("RESPONSIBLE_USER_UNAUTHORIZED");
    expect(copy.description).toContain("the responsible user");
  });

  it("steers the unavailable case toward marking work blocked", () => {
    const copy = describeResponsibleUserDenial("RESPONSIBLE_USER_UNAVAILABLE", {
      userName: "Grace Hopper",
    });
    expect(copy.description).toContain("Grace Hopper");
    expect(copy.recommendedAction.toLowerCase()).toContain("blocked");
  });

  it("never uses the word impersonate", () => {
    for (const code of RESPONSIBLE_USER_DENIAL_CODES) {
      const copy = describeResponsibleUserDenial(code, { userName: "Someone" });
      const blob = `${copy.title} ${copy.description} ${copy.recommendedAction}`.toLowerCase();
      expect(blob).not.toContain("impersonate");
    }
  });
});
