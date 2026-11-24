import { describe, expect, it } from "vitest";

import { ANTIGRAVITY_SWARM_PROVIDER_MODE, NATIVE_MODEL_ENVELOPE_SCHEMA, NATIVE_SWARM_REQUEST_MAX_CHARS } from "../../contracts/native-execution.js";
import { ANTIGRAVITY_SWARM_MODE } from "./antigravity-swarm-guard.js";
import {
  classifyGeneratedAcpxToolOperation,
  GENERATED_ANTIGRAVITY_SWARM_ENVELOPE_SCHEMA,
  GENERATED_ANTIGRAVITY_SWARM_PROVIDER_MODE,
  GENERATED_ANTIGRAVITY_SWARM_REQUEST_MAX_CHARS,
  GENERATED_ANTIGRAVITY_SWARM_CHANNELS,
  GENERATED_ANTIGRAVITY_SWARM_CREDENTIAL_FACTS_FIELD,
  GENERATED_ANTIGRAVITY_SWARM_DEFAULT_CHANNEL,
  readGeneratedAntigravitySwarmCredentialFacts,
} from "./generated-sidecar-contract.js";
import { antigravityAccountDigest, antigravitySwarmBinding } from "./antigravity-swarm-route.js";

describe("generated ACPX sidecar tool classification", () => {
  it("uses ASCII case mapping for both provider kinds and fallback titles", () => {
    expect(classifyGeneratedAcpxToolOperation("ſearch", undefined)).toBe(
      "execute",
    );
    expect(classifyGeneratedAcpxToolOperation(undefined, "ſearch")).toBe(
      "execute",
    );
    expect(classifyGeneratedAcpxToolOperation("SEARCH", undefined)).toBe(
      "search",
    );
    expect(classifyGeneratedAcpxToolOperation(undefined, "WRITE")).toBe("edit");
  });

  it("continues classifying the complete provider value", () => {
    expect(
      classifyGeneratedAcpxToolOperation(`${"x".repeat(240)}WRITE`, undefined),
    ).toBe("edit");
  });
});

describe("generated Antigravity swarm turn contract", () => {
  it("is the one source for the swarm mode, the envelope the route reads and the request bound", () => {
    expect(ANTIGRAVITY_SWARM_MODE).toBe(GENERATED_ANTIGRAVITY_SWARM_PROVIDER_MODE);
    expect(ANTIGRAVITY_SWARM_PROVIDER_MODE).toBe(GENERATED_ANTIGRAVITY_SWARM_PROVIDER_MODE);
    expect(NATIVE_SWARM_REQUEST_MAX_CHARS).toBe(GENERATED_ANTIGRAVITY_SWARM_REQUEST_MAX_CHARS);
    // The Runner writes the envelope the swarm route reads; a new envelope revision must update the schema.
    expect(NATIVE_MODEL_ENVELOPE_SCHEMA).toBe(GENERATED_ANTIGRAVITY_SWARM_ENVELOPE_SCHEMA);
  });
});

describe("generated Antigravity swarm credential facts", () => {
  it("declares a closed channel set and a lowercase sha256 account digest, read by the swarm route", () => {
    expect(GENERATED_ANTIGRAVITY_SWARM_CHANNELS).toEqual(["provider_default", "stable"]);
    expect(GENERATED_ANTIGRAVITY_SWARM_DEFAULT_CHANNEL).toBe("provider_default");
    expect(GENERATED_ANTIGRAVITY_SWARM_CREDENTIAL_FACTS_FIELD).toBe("paperclip");
    const digest = antigravityAccountDigest("owner@example.test");
    expect(readGeneratedAntigravitySwarmCredentialFacts({ swarmChannel: "stable", accountSha256: digest })).toEqual({ swarmChannel: "stable", accountSha256: digest });
    expect(readGeneratedAntigravitySwarmCredentialFacts({})).toEqual({});
    for (const invalid of [{ swarmChannel: "daily" }, { accountSha256: digest.toUpperCase() }, { accountSha256: "ab" }, { extra: true }, [], null]) {
      expect(readGeneratedAntigravitySwarmCredentialFacts(invalid)).toBeNull();
    }
    expect(antigravitySwarmBinding({ PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: JSON.stringify({ [GENERATED_ANTIGRAVITY_SWARM_CREDENTIAL_FACTS_FIELD]: { swarmChannel: "stable" } }) }))
      .toEqual({ channel: "stable", accountDigest: null });
  });
});
