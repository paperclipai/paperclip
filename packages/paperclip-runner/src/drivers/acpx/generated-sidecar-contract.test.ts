import { describe, expect, it } from "vitest";

import { ANTIGRAVITY_SWARM_PROVIDER_MODE, NATIVE_MODEL_ENVELOPE_SCHEMA, NATIVE_SWARM_REQUEST_MAX_CHARS } from "../../contracts/native-execution.js";
import { ANTIGRAVITY_SWARM_MODE } from "./antigravity-swarm-guard.js";
import {
  classifyGeneratedAcpxToolOperation,
  GENERATED_ANTIGRAVITY_SWARM_ENVELOPE_SCHEMA,
  GENERATED_ANTIGRAVITY_SWARM_PROVIDER_MODE,
  GENERATED_ANTIGRAVITY_SWARM_REQUEST_MAX_CHARS,
} from "./generated-sidecar-contract.js";

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
