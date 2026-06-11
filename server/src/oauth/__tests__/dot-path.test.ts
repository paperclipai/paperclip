import { describe, it, expect } from "vitest";
import { getByPath } from "../dot-path.js";

describe("getByPath", () => {
  it("reads top-level field", () => expect(getByPath({ id: 1 }, "id")).toBe(1));
  it("reads nested field", () => expect(getByPath({ team: { id: "abc" } }, "team.id")).toBe("abc"));
  it("returns null for missing nested", () => expect(getByPath({ a: {} }, "a.b.c")).toBeNull());
  it("returns null for null intermediates", () => expect(getByPath({ a: null }, "a.b")).toBeNull());
  it("returns null for non-object root", () => expect(getByPath(null as unknown, "a.b")).toBeNull());
  it("ignores prototype pollution paths", () => {
    expect(getByPath({}, "__proto__.polluted")).toBeNull();
    expect(getByPath({}, "constructor.prototype")).toBeNull();
  });
});
