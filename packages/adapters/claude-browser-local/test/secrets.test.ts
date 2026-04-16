import { describe, expect, it } from "vitest";
import {
  resolveAllSecrets,
  tokenizeSecrets,
} from "../src/server/tools/secrets.js";

describe("tokenizeSecrets", () => {
  it("extracts uppercase-underscore secret names", () => {
    const tokens = tokenizeSecrets(
      "hello {{SECRET:DEVTO_PASSWORD}} world {{SECRET:IMAP_PASS}}",
    );
    expect(tokens.map((t) => t.name)).toEqual(["DEVTO_PASSWORD", "IMAP_PASS"]);
  });

  it("returns empty for strings with no tokens", () => {
    expect(tokenizeSecrets("plain text")).toEqual([]);
  });
});

describe("resolveAllSecrets", () => {
  it("substitutes resolved values and reports unresolved tokens", async () => {
    const { resolved, unresolved } = await resolveAllSecrets(
      "pw={{SECRET:DEVTO_PASSWORD}} k={{SECRET:UNKNOWN}}",
      async (name) => (name === "DEVTO_PASSWORD" ? "hunter2" : null),
    );
    expect(resolved).toBe("pw=hunter2 k={{SECRET:UNKNOWN}}");
    expect(unresolved).toEqual(["UNKNOWN"]);
  });

  it("is a no-op for strings with no tokens", async () => {
    const { resolved, unresolved } = await resolveAllSecrets(
      "hello world",
      async () => "nope",
    );
    expect(resolved).toBe("hello world");
    expect(unresolved).toEqual([]);
  });
});
