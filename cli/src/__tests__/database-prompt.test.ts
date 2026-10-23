import { describe, expect, it } from "vitest";
import { normalizeConnectionStringCredentials } from "../prompts/database.js";

describe("normalizeConnectionStringCredentials", () => {
  it("leaves an already-valid connection string untouched", () => {
    const value = "postgres://user:plainpass@localhost:5432/paperclip";
    expect(normalizeConnectionStringCredentials(value)).toBe(value);
  });

  it("encodes a password containing '#'", () => {
    const value = "postgres://user:p#ssword@localhost:5432/paperclip";
    const result = normalizeConnectionStringCredentials(value);
    const parsed = new URL(result);
    expect(decodeURIComponent(parsed.password)).toBe("p#ssword");
  });

  it("encodes a password containing '?' and '/'", () => {
    const value = "postgres://user:p?ss/word@localhost:5432/paperclip";
    const result = normalizeConnectionStringCredentials(value);
    const parsed = new URL(result);
    expect(decodeURIComponent(parsed.password)).toBe("p?ss/word");
    expect(parsed.hostname).toBe("localhost");
    expect(parsed.pathname).toBe("/paperclip");
  });

  it("leaves a password containing a literal '@' untouched since the URL spec already handles it", () => {
    const value = "postgres://user:p@ssw0rd@localhost:5432/paperclip";
    const result = normalizeConnectionStringCredentials(value);
    expect(result).toBe(value);
    const parsed = new URL(result);
    expect(decodeURIComponent(parsed.password)).toBe("p@ssw0rd");
  });

  it("returns non-URL input unchanged instead of throwing", () => {
    expect(normalizeConnectionStringCredentials("not-a-url")).toBe("not-a-url");
    expect(normalizeConnectionStringCredentials("")).toBe("");
  });
});
