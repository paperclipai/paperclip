import { describe, expect, it } from "vitest";

describe("localStorage shim", () => {
  it("supports clear and reset semantics", () => {
    localStorage.setItem("a", "1");
    localStorage.setItem("b", "2");

    expect(localStorage.length).toBe(2);
    expect(localStorage.getItem("a")).toBe("1");

    localStorage.clear();

    expect(localStorage.length).toBe(0);
    expect(localStorage.getItem("a")).toBeNull();
    expect(localStorage.key(0)).toBeNull();
  });
});
