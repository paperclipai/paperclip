import { describe, it, expect } from "vitest";
import rateLimit from "express-rate-limit";

describe("auth rate limiter", () => {
  it("express-rate-limit is importable", () => {
    expect(typeof rateLimit).toBe("function");
  });

  it("creates a middleware function", () => {
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many authentication attempts. Please try again later." },
    });
    expect(typeof limiter).toBe("function");
  });
});
