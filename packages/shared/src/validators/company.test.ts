import { describe, expect, it } from "vitest";
import { INTERACTION_RESOLVER_GOVERNANCE_KINDS } from "../constants.js";
import {
  createCompanySchema,
  interactionResolverGovernanceSchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "./company.js";
import { portabilityCompanyManifestEntrySchema } from "./company-portability.js";

describe("company schemas without the retired settings", () => {
  it("strips brandColor and attachmentMaxBytes from a create payload", () => {
    const parsed = createCompanySchema.parse({
      name: "Acme",
      brandColor: "#123456",
      attachmentMaxBytes: 25_000_000,
    });

    expect(parsed).not.toHaveProperty("brandColor");
    expect(parsed).not.toHaveProperty("attachmentMaxBytes");
    expect(parsed.name).toBe("Acme");
  });

  it("strips brandColor and attachmentMaxBytes from an update payload", () => {
    const parsed = updateCompanySchema.parse({
      description: "Updated",
      brandColor: "#123456",
      attachmentMaxBytes: 25_000_000,
    });

    expect(parsed).not.toHaveProperty("brandColor");
    expect(parsed).not.toHaveProperty("attachmentMaxBytes");
    expect(parsed.description).toBe("Updated");
  });

  it("rejects brandColor on the strict branding schema", () => {
    const result = updateCompanyBrandingSchema.safeParse({
      name: "Acme",
      brandColor: "#123456",
    });

    expect(result.success).toBe(false);
  });

  it("still accepts the remaining branding fields", () => {
    const result = updateCompanyBrandingSchema.safeParse({
      name: "Acme",
      description: null,
      logoAssetId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.success).toBe(true);
  });

  it("requires at least one branding field", () => {
    expect(updateCompanyBrandingSchema.safeParse({}).success).toBe(false);
  });
});

describe("interaction resolver governance schema", () => {
  it("accepts a cap for connection_intent, which the settings UI offers", () => {
    const parsed = updateCompanySchema.parse({
      interactionResolverGovernance: {
        connection_intent: { cap: "human_only" },
      },
    });

    expect(parsed.interactionResolverGovernance).toEqual({
      connection_intent: { cap: "human_only" },
    });
  });

  it("accepts governance for every kind the settings panel offers", () => {
    const governance = Object.fromEntries(
      INTERACTION_RESOLVER_GOVERNANCE_KINDS.map((kind) => [
        kind,
        { defaultPolicy: "anyone", cap: "human_only" },
      ]),
    );

    const parsed = updateCompanySchema.parse({ interactionResolverGovernance: governance });

    expect(parsed.interactionResolverGovernance).toEqual(governance);
  });

  it("declares exactly the governable interaction kinds", () => {
    expect(Object.keys(interactionResolverGovernanceSchema.unwrap().shape).sort()).toEqual(
      [...INTERACTION_RESOLVER_GOVERNANCE_KINDS].sort(),
    );
  });

  it("rejects governance for a server-authored interaction kind", () => {
    const result = updateCompanySchema.safeParse({
      interactionResolverGovernance: {
        suggest_routine: { cap: "human_only" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("still rejects an unknown interaction kind", () => {
    const result = updateCompanySchema.safeParse({
      interactionResolverGovernance: {
        not_a_real_kind: { cap: "human_only" },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("portability company manifest tolerance", () => {
  it("accepts a legacy manifest entry carrying the retired keys and ignores them", () => {
    const parsed = portabilityCompanyManifestEntrySchema.parse({
      path: "company.md",
      name: "Acme",
      description: null,
      brandColor: "#5c5fff",
      logoPath: null,
      attachmentMaxBytes: 25_000_000,
      requireBoardApprovalForNewAgents: false,
    });

    expect(parsed).not.toHaveProperty("brandColor");
    expect(parsed).not.toHaveProperty("attachmentMaxBytes");
    expect(parsed.name).toBe("Acme");
  });
});
