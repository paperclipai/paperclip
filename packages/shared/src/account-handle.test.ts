import { describe, expect, it } from "vitest";
import { ACCOUNT_HANDLE_MAX_LENGTH, toAccountHandle } from "./account-handle.js";
import { createUserSecretDefinitionSchema } from "./validators/secret.js";

describe("toAccountHandle", () => {
  it("returns the value for a plain identifier", () => {
    expect(toAccountHandle("acct-42")).toBe("acct-42");
  });

  it("returns null for a value that holds a space, such as \"a b\"", () => {
    expect(toAccountHandle("a b")).toBeNull();
  });

  it("returns null for a value with surrounding whitespace instead of trimming it", () => {
    // Trimming a value before validation would let " acct-42" and "acct-42"
    // resolve to the same handle. Two distinct identifiers must never share
    // one handle, so surrounding whitespace is a rejection, not something to
    // strip.
    expect(toAccountHandle(" acct-42")).toBeNull();
    expect(toAccountHandle("acct-42 ")).toBeNull();
    expect(toAccountHandle(" acct-42 ")).toBeNull();
    expect(toAccountHandle("\tacct-42\n")).toBeNull();
    // The plain identifier with no surrounding whitespace still passes.
    expect(toAccountHandle("acct-42")).toBe("acct-42");
  });

  it("returns null for an empty string", () => {
    expect(toAccountHandle("")).toBeNull();
  });

  it("returns null for a value that holds a plus sign, such as \"a+b\"", () => {
    expect(toAccountHandle("a+b")).toBeNull();
  });

  it("returns null for a value that holds a colon, such as \"a:b\"", () => {
    expect(toAccountHandle("a:b")).toBeNull();
  });

  it("returns null for a value longer than 100 characters", () => {
    const tooLong = "a".repeat(ACCOUNT_HANDLE_MAX_LENGTH + 1);
    expect(toAccountHandle(tooLong)).toBeNull();
    const atLimit = "a".repeat(ACCOUNT_HANDLE_MAX_LENGTH);
    expect(toAccountHandle(atLimit)).toBe(atLimit);
  });

  it("returns null for \".\" and for \"..\"", () => {
    expect(toAccountHandle(".")).toBeNull();
    expect(toAccountHandle("..")).toBeNull();
  });

  it("returns null for a value that starts with a hyphen, such as \"-rf\"", () => {
    expect(toAccountHandle("-rf")).toBeNull();
  });

  it("returns null for a value that holds a shell metacharacter, such as \"$(id)\"", () => {
    expect(toAccountHandle("$(id)")).toBeNull();
  });

  it("returns null for a value that holds a path separator or a NUL byte", () => {
    expect(toAccountHandle("a/b")).toBeNull();
    expect(toAccountHandle("a\\b")).toBeNull();
    expect(toAccountHandle("a\0b")).toBeNull();
  });

  it("every accepted handle also passes the secret key schema", () => {
    const candidates = ["acct-42", "acct_42", "ACCT.42", "a".repeat(ACCOUNT_HANDLE_MAX_LENGTH)];
    for (const candidate of candidates) {
      const handle = toAccountHandle(candidate);
      expect(handle).not.toBeNull();
      expect(createUserSecretDefinitionSchema.shape.key.safeParse(handle).success).toBe(true);
    }
  });
});
