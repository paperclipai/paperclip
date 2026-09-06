import { describe, expect, it } from "vitest";
import {
  configureChatEndpointSchema,
  microsoftTeamsCredentialIdSchema,
  resolveChatActionSchema,
} from "./chat-channels.js";

describe("Microsoft Teams chat credential validation", () => {
  it("normalizes canonical Entra application and tenant UUIDs", () => {
    const parsed = configureChatEndpointSchema.parse({
      action: "configure",
      credentials: {
        clientId: " 76D0CB17-5EC4-4B3D-983B-DA8A01DC02C4 ",
        tenantId: "F8CDEF31-A31E-4B4A-93E4-5F571E91255A",
        clientSecret: "keep-case-sensitive-secret",
      },
    });

    expect(parsed.credentials).toEqual({
      clientId: "76d0cb17-5ec4-4b3d-983b-da8a01dc02c4",
      tenantId: "f8cdef31-a31e-4b4a-93e4-5f571e91255a",
      clientSecret: "keep-case-sensitive-secret",
    });
  });

  it.each([
    "common",
    "organizations",
    "contoso.onmicrosoft.com",
    "76d0cb175ec44b3d983bda8a01dc02c4",
    "00000000-0000-0000-0000-000000000000",
  ])("rejects non-canonical Teams credential id %s", (value) => {
    expect(microsoftTeamsCredentialIdSchema.safeParse(value).success).toBe(
      false,
    );
    expect(
      configureChatEndpointSchema.safeParse({
        action: "configure",
        credentials: {
          clientId: "76d0cb17-5ec4-4b3d-983b-da8a01dc02c4",
          tenantId: value,
          clientSecret: "secret",
        },
      }).success,
    ).toBe(false);
  });

  it("does not impose Teams UUID rules on unrelated provider credentials", () => {
    expect(
      configureChatEndpointSchema.parse({
        action: "configure",
        credentials: {
          botToken: "xoxb-test",
          signingSecret: "secret",
        },
      }),
    ).toEqual({
      action: "configure",
      credentials: {
        botToken: "xoxb-test",
        signingSecret: "secret",
      },
    });
  });
});

describe("chat provider-action resolution validation", () => {
  it.each(["mark_delivered", "retry_anyway", "cancel"] as const)(
    "accepts the explicit %s resolution",
    (action) => {
      expect(resolveChatActionSchema.parse({ action })).toEqual({ action });
    },
  );

  it("rejects automatic or unknown provider-effect replay modes", () => {
    expect(resolveChatActionSchema.safeParse({ action: "retry" }).success).toBe(
      false,
    );
  });
});
