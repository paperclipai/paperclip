import { describe, it, expect } from "vitest";
import { resolveProjectId } from "../src/repo-resolver.js";

const MAP = { "acme/foo": "proj-1", "acme/bar": "proj-2" };

describe("resolveProjectId", () => {
  it("returns project for mapped repo", () => {
    expect(resolveProjectId("acme/foo", MAP)).toBe("proj-1");
  });
  it("returns null for unmapped repo", () => {
    expect(resolveProjectId("acme/baz", MAP)).toBeNull();
  });
  it("returns null for empty map", () => {
    expect(resolveProjectId("acme/foo", {})).toBeNull();
  });
});
