import { describe, it, expect } from "vitest";
import { isAllowedDevHost } from "../routes/plugin-ui-static.js";

describe("isAllowedDevHost", () => {
  it("accepts localhost", () => {
    expect(isAllowedDevHost("localhost", [])).toBe(true);
  });

  it("accepts 127.0.0.1", () => {
    expect(isAllowedDevHost("127.0.0.1", [])).toBe(true);
  });

  it("accepts ::1 variants", () => {
    expect(isAllowedDevHost("::1", [])).toBe(true);
    expect(isAllowedDevHost("[::1]", [])).toBe(true);
    expect(isAllowedDevHost("0:0:0:0:0:0:0:1", [])).toBe(true);
  });

  it("accepts hostname in allowedHostnames", () => {
    expect(isAllowedDevHost("dev.example.com", ["dev.example.com"])).toBe(true);
  });

  it("rejects unknown hostname", () => {
    expect(isAllowedDevHost("evil.com", ["dev.example.com"])).toBe(false);
  });
});
