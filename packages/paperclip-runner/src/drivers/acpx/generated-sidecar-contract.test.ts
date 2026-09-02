import { describe, expect, it } from "vitest";

import { classifyGeneratedAcpxToolOperation } from "./generated-sidecar-contract.js";

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
