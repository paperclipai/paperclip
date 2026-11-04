import { describe, expect, it } from "vitest";
import {
  normalizeMicrosoftTeamsCredentialIds,
  normalizeMicrosoftTeamsExternalPrincipalId,
} from "./chat-teams-credentials.js";

describe("Microsoft Teams service credential normalization", () => {
  it("canonicalizes IDs without changing or mutating the client secret", () => {
    const input = {
      clientId: " 76D0CB17-5EC4-4B3D-983B-DA8A01DC02C4 ",
      tenantId: "F8CDEF31-A31E-4B4A-93E4-5F571E91255A",
      clientSecret: " Case-Sensitive Secret ",
    };

    expect(normalizeMicrosoftTeamsCredentialIds(input)).toEqual({
      clientId: "76d0cb17-5ec4-4b3d-983b-da8a01dc02c4",
      tenantId: "f8cdef31-a31e-4b4a-93e4-5f571e91255a",
      clientSecret: " Case-Sensitive Secret ",
    });
    expect(input.clientId).toContain("76D0CB17");
  });

  it.each([
    ["clientId", "not-an-app-id"],
    ["tenantId", "common"],
    ["tenantId", "contoso.onmicrosoft.com"],
    ["tenantId", "00000000-0000-0000-0000-000000000000"],
  ] as const)("rejects invalid %s values", (field, value) => {
    const credentials = {
      clientId: "76d0cb17-5ec4-4b3d-983b-da8a01dc02c4",
      tenantId: "f8cdef31-a31e-4b4a-93e4-5f571e91255a",
      clientSecret: "secret",
      [field]: value,
    };

    expect(() => normalizeMicrosoftTeamsCredentialIds(credentials)).toThrow(
      expect.objectContaining({
        status: 422,
        details: expect.objectContaining({
          code: "chat_provider_credentials_invalid",
          provider: "microsoft-teams",
          field,
        }),
      }),
    );
  });

  it("canonicalizes an Entra user object id and otherwise preserves the adapter identity", () => {
    expect(
      normalizeMicrosoftTeamsExternalPrincipalId(
        " 76D0CB17-5EC4-4B3D-983B-DA8A01DC02C4 ",
        "29:adapter-user",
      ),
    ).toBe("76d0cb17-5ec4-4b3d-983b-da8a01dc02c4");
    expect(
      normalizeMicrosoftTeamsExternalPrincipalId(undefined, "29:adapter-user"),
    ).toBe("29:adapter-user");
    expect(
      normalizeMicrosoftTeamsExternalPrincipalId(
        "not-an-entra-id",
        "29:adapter-user",
      ),
    ).toBe("29:adapter-user");
  });
});
