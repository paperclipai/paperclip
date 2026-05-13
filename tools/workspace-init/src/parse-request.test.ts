import { describe, it, expect } from "vitest";
import { parseRequest } from "./parse-request.js";

describe("parseRequest", () => {
  it("rejects unsupported version", () => {
    expect(() =>
      parseRequest(JSON.stringify({ version: 2, source: { strategy: "project_primary" } })),
    ).toThrow(/unsupported version/);
  });

  it("rejects missing source", () => {
    expect(() => parseRequest(JSON.stringify({ version: 1 }))).toThrow(
      /missing source.strategy/,
    );
  });

  it("rejects non-string source.strategy", () => {
    expect(() =>
      parseRequest(JSON.stringify({ version: 1, source: { strategy: 42 } })),
    ).toThrow(/missing source.strategy/);
  });

  it("accepts the minimal shape the K8s server emits for adapter-managed runs", () => {
    // This is the exact JSON shape produced by server/src/index.ts
    // resolveRunContext for M2's claude_local-in-K8s path. Update both
    // ends if you change this — the wire contract spans server →
    // workspace-init.
    const wire = JSON.stringify({
      version: 1,
      source: { strategy: "adapter_managed" },
    });
    const parsed = parseRequest(wire);
    expect(parsed.version).toBe(1);
    expect(parsed.source.strategy).toBe("adapter_managed");
  });

  it("accepts project_primary with full source fields", () => {
    const parsed = parseRequest(
      JSON.stringify({
        version: 1,
        source: {
          strategy: "project_primary",
          repoUrl: "https://github.com/acme/repo.git",
          repoRef: "main",
        },
      }),
    );
    expect(parsed.source.strategy).toBe("project_primary");
  });
});
