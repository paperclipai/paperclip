import { describe, it, expect } from "vitest";
import { issueOriginKind, issueOriginId, prOriginKind, prOriginId, parseOriginId } from "../src/origin-ref.js";

describe("origin-ref", () => {
  it("issueOriginKind is namespaced by plugin id", () => {
    expect(issueOriginKind()).toBe("plugin:paperclip-plugin-github-issues:issue");
  });

  it("issueOriginId combines repo+number deterministically", () => {
    expect(issueOriginId("acme/foo", 42)).toBe("acme/foo#42");
  });

  it("prOriginKind is distinct from issue", () => {
    expect(prOriginKind()).toBe("plugin:paperclip-plugin-github-issues:pr");
    expect(prOriginKind()).not.toBe(issueOriginKind());
  });

  it("prOriginId combines repo+number", () => {
    expect(prOriginId("acme/foo", 7)).toBe("acme/foo#7");
  });

  it("parseOriginId roundtrips", () => {
    expect(parseOriginId("acme/foo#42")).toEqual({ repo: "acme/foo", number: 42 });
  });

  it("parseOriginId returns null on garbage", () => {
    expect(parseOriginId("not-a-valid-id")).toBeNull();
  });
});
