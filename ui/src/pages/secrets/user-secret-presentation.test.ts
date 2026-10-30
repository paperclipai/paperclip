import { describe, expect, it } from "vitest";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import {
  coverageSummaryLabel,
  myValueLabel,
  secretStatusTone,
} from "./user-secret-presentation";
import { myValueState } from "./my-value-state";

function makeSecret(status: CompanySecret["status"]): CompanySecret {
  return {
    id: "sec-1",
    companyId: "c1",
    scope: "user",
    ownerUserId: "u1",
    userSecretDefinitionId: "def-1",
    key: "PERSONAL_GH_TOKEN",
    name: "Personal GH token",
    provider: "local_encrypted",
    status,
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: "u1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const definition = { id: "def-1", key: "PERSONAL_GH_TOKEN" } as UserSecretDefinition;

describe("coverageSummaryLabel", () => {
  it("shows counts only, never values", () => {
    expect(
      coverageSummaryLabel({
        definitionId: "def-1",
        configuredCount: 5,
        missingCount: 2,
        inactiveCount: 0,
      }),
    ).toBe("5 of 7 set");
  });

  it("counts inactive members in the total", () => {
    expect(
      coverageSummaryLabel({
        definitionId: "def-1",
        configuredCount: 3,
        missingCount: 1,
        inactiveCount: 1,
      }),
    ).toBe("3 of 5 set");
  });

  it("renders a dash when coverage is unknown", () => {
    expect(coverageSummaryLabel(undefined)).toBe("—");
  });
});

describe("myValueState", () => {
  it("is not_set when the user has no value", () => {
    expect(myValueState(definition, null)).toBe("not_set");
    expect(myValueLabel(myValueState(definition, null))).toBe("Not set");
  });

  it("is set when an active value exists", () => {
    expect(myValueState(definition, makeSecret("active"))).toBe("set");
  });

  it("is inactive when the value is disabled", () => {
    expect(myValueState(definition, makeSecret("disabled"))).toBe("inactive");
  });
});

describe("secretStatusTone", () => {
  it("uses emerald for active and muted for disabled", () => {
    expect(secretStatusTone("active")).toContain("emerald");
    expect(secretStatusTone("disabled")).toContain("muted");
  });
});
