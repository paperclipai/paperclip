import { describe, expect, it } from "vitest";
import {
  effectiveToolProfileBindings,
  narrowestScopeBindings,
} from "./tool-profile-binding-precedence.js";

const createdAt = new Date("2026-08-11T00:00:00.000Z");

describe("tool profile binding precedence", () => {
  it("keeps ordinary profiles at the narrowest matching scope", () => {
    const companyBinding = {
      profileId: "company-profile",
      targetType: "company" as const,
      targetId: "company-1",
      priority: 100,
      createdAt,
    };
    const agentBinding = {
      profileId: "agent-profile",
      targetType: "agent" as const,
      targetId: "agent-1",
      priority: 100,
      createdAt,
    };

    expect(narrowestScopeBindings([companyBinding, agentBinding])).toEqual([agentBinding]);
    expect(effectiveToolProfileBindings(
      [companyBinding, agentBinding],
      [
        { id: "company-profile", profileKey: "company-default", metadata: {} },
        { id: "agent-profile", profileKey: "agent-default", metadata: {} },
      ],
      "connection-1",
    )).toEqual([agentBinding]);
  });

  it("carries the wizard-managed app assignment alongside a narrower profile", () => {
    const appBinding = {
      profileId: "app-profile",
      targetType: "company" as const,
      targetId: "company-1",
      priority: 100,
      createdAt,
    };
    const agentBinding = {
      profileId: "agent-profile",
      targetType: "agent" as const,
      targetId: "agent-1",
      priority: 100,
      createdAt,
    };

    expect(effectiveToolProfileBindings(
      [appBinding, agentBinding],
      [
        {
          id: "app-profile",
          profileKey: "app:connection-1",
          metadata: { source: "app_gallery_finish", connectionId: "connection-1" },
        },
        { id: "agent-profile", profileKey: "agent-default", metadata: {} },
      ],
      "connection-1",
    )).toEqual([agentBinding, appBinding]);
  });

  it("does not carry wizard-managed app assignments into a gateway-only profile", () => {
    const appBinding = {
      profileId: "app-profile",
      targetType: "company" as const,
      targetId: "company-1",
      priority: 100,
      createdAt,
    };
    const gatewayBinding = {
      profileId: "gateway-profile",
      targetType: "gateway" as const,
      targetId: "gateway-1",
      priority: 10,
      createdAt,
    };

    expect(effectiveToolProfileBindings(
      [appBinding, gatewayBinding],
      [
        {
          id: "app-profile",
          profileKey: "app:connection-1",
          metadata: { source: "app_gallery_finish", connectionId: "connection-1" },
        },
        { id: "gateway-profile", profileKey: "runtime-gateway", metadata: {} },
      ],
      "connection-1",
      { includeAdditiveAppProfiles: false },
    )).toEqual([gatewayBinding]);
  });

  it("does not overlay a wizard profile onto another connection", () => {
    const appBinding = {
      profileId: "app-profile",
      targetType: "company" as const,
      targetId: "company-1",
      priority: 100,
      createdAt,
    };
    const agentBinding = {
      profileId: "agent-profile",
      targetType: "agent" as const,
      targetId: "agent-1",
      priority: 100,
      createdAt,
    };

    expect(effectiveToolProfileBindings(
      [appBinding, agentBinding],
      [{
        id: "app-profile",
        profileKey: "app:connection-1",
        metadata: { source: "app_gallery_finish", connectionId: "connection-1" },
      }],
      "connection-2",
    )).toEqual([agentBinding]);
  });
});
