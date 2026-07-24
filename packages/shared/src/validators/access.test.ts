import { describe, expect, it } from "vitest";
import { authSessionSchema, currentUserProfileSchema } from "./access.js";

describe("currentUserProfileSchema", () => {
  it("coerces empty-string name to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("coerces whitespace-only name to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "   ",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("preserves a real name unchanged", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe("Jane");
  });

  it("preserves null name as null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: null,
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("coerces empty-string email to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe(null);
  });

  it("coerces whitespace-only email to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "   ",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe(null);
  });

  it("preserves a real email unchanged", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe("a@b.com");
  });

  it("preserves null email as null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: null,
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe(null);
  });

  it("still rejects a malformed non-empty email", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "not-an-email",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("authSessionSchema", () => {
  it("parses a session where user name is empty string (identity provider without a name)", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "", image: null },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe(null);
  });

  it("parses a session where user has a real name", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe("Jane");
  });

  it("parses a session where user name is null", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: null, image: null },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe(null);
  });

  it("parses a session where user email is empty string (identity provider without an email)", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "", name: "Jane", image: null },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.email).toBe(null);
  });
});
