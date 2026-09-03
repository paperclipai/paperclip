import { describe, expect, it } from "vitest";
import { deriveCodexSubscriptionCredentialIdentity } from "./codex-credential-identity.js";

function subscriptionAuth(accountId: string, marker: string): string {
  return JSON.stringify({
    tokens: {
      account_id: accountId,
      id_token: `id-${marker}`,
      access_token: `access-${marker}`,
      refresh_token: `refresh-${marker}`,
    },
  });
}

describe("deriveCodexSubscriptionCredentialIdentity", () => {
  it("is stable across token refreshes for the same account", () => {
    const before = deriveCodexSubscriptionCredentialIdentity(
      subscriptionAuth("acct-same", "before"),
    );
    const after = deriveCodexSubscriptionCredentialIdentity(subscriptionAuth("acct-same", "after"));

    expect(before).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(after).toBe(before);
  });

  it("changes when the subscription account changes", () => {
    const first = deriveCodexSubscriptionCredentialIdentity(subscriptionAuth("acct-first", "one"));
    const second = deriveCodexSubscriptionCredentialIdentity(subscriptionAuth("acct-second", "two"));

    expect(first).not.toBe(second);
  });

  it("does not derive a subscription identity from malformed or API-key credentials", () => {
    expect(deriveCodexSubscriptionCredentialIdentity("not-json")).toBeNull();
    expect(
      deriveCodexSubscriptionCredentialIdentity(
        JSON.stringify({ OPENAI_API_KEY: "sk-secret" }),
      ),
    ).toBeNull();
    expect(
      deriveCodexSubscriptionCredentialIdentity(
        JSON.stringify({ tokens: { account_id: "acct-only" } }),
      ),
    ).toBeNull();
  });

  it("does not expose raw account or token material", () => {
    const identity = deriveCodexSubscriptionCredentialIdentity(
      subscriptionAuth("RAW-ACCOUNT-SENTINEL", "RAW-TOKEN-SENTINEL"),
    );

    expect(identity).not.toContain("RAW-ACCOUNT-SENTINEL");
    expect(identity).not.toContain("RAW-TOKEN-SENTINEL");
  });
});
