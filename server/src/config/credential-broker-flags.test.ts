import { afterEach, describe, expect, it } from "vitest";

import {
  __clearCredentialBrokerFlagsForTests,
  credentialBrokerFeatureEnabled,
  credentialBrokerRequired,
} from "./credential-broker-flags.js";

afterEach(() => {
  __clearCredentialBrokerFlagsForTests();
});

describe("credentialBrokerFeatureEnabled", () => {
  it("defaults to false when the env var is unset", () => {
    expect(credentialBrokerFeatureEnabled()).toBe(false);
  });

  it.each(["1", "true", "True", "yes", "on", " 1 "])(
    "is true for %j",
    (value) => {
      process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = value;
      expect(credentialBrokerFeatureEnabled()).toBe(true);
    },
  );

  it.each(["0", "false", "no", "off", "", "abc"])("is false for %j", (value) => {
    process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = value;
    expect(credentialBrokerFeatureEnabled()).toBe(false);
  });
});

describe("credentialBrokerRequired", () => {
  it("defaults to false", () => {
    expect(credentialBrokerRequired()).toBe(false);
  });

  it("is true when set to 1", () => {
    process.env.PAPERCLIP_REQUIRE_BROKER = "1";
    expect(credentialBrokerRequired()).toBe(true);
  });

  it("is independent of the feature flag", () => {
    process.env.PAPERCLIP_REQUIRE_BROKER = "1";
    expect(credentialBrokerFeatureEnabled()).toBe(false);
    expect(credentialBrokerRequired()).toBe(true);
  });
});
