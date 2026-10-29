import { describe, expect, it } from "vitest";
import { isChatEndpointRepairing } from "./ChatEndpointSetup";

describe("chat endpoint setup recovery state", () => {
  it("keeps a secret-only GitHub endpoint in first-time setup", () => {
    expect(
      isChatEndpointRepairing(
        {
          provider: "github",
          status: "attention",
          providerAccountId: null,
          botExternalId: null,
        },
        "github-endpoint",
        false,
      ),
    ).toBe(false);
  });

  it("offers reconnect only after GitHub has an immutable provider identity", () => {
    expect(
      isChatEndpointRepairing(
        {
          provider: "github",
          status: "attention",
          providerAccountId: "github-app-123",
          botExternalId: "github-app-registration-456",
        },
        "github-endpoint",
        false,
      ),
    ).toBe(true);
  });

  it("preserves explicit reconnect for an active endpoint", () => {
    expect(
      isChatEndpointRepairing(
        {
          provider: "slack",
          status: "active",
          providerAccountId: "workspace-123",
          botExternalId: "bot-123",
        },
        "slack-endpoint",
        true,
      ),
    ).toBe(true);
  });
});
