import { describe, expect, it } from "vitest";
import { createAgentIdentityRedactor, secretEnvironmentOutputValues } from "./agent-identity-redaction.js";

const REDACTED = "***REDACTED***";

describe("secret environment output values", () => {
  it("selects only secret-bound values and leaves plain values alone", () => {
    const values = secretEnvironmentOutputValues({
      STRIPE_KEY: "sk_test_synthetic_0123456789",
      PLAIN_URL: "https://plain.example.test/api",
    }, new Set(["STRIPE_KEY"]));
    expect(values).toEqual(["sk_test_synthetic_0123456789"]);
  });

  it("skips values shorter than the minimum length and whitespace-only values", () => {
    expect(secretEnvironmentOutputValues({
      SHORT: "abc1234",
      SINGLE: "x",
      EMPTY: "",
      BLANK: "            ",
      PADDED: "  abc  ",
    }, ["SHORT", "SINGLE", "EMPTY", "BLANK", "PADDED"])).toEqual([]);
    expect(secretEnvironmentOutputValues({ EDGE: "abcd1234" }, ["EDGE"])).toEqual(["abcd1234"]);
  });

  it("ignores a secret key that has no string value", () => {
    expect(secretEnvironmentOutputValues({ NUMBER: 12345678 }, ["NUMBER", "MISSING"])).toEqual([]);
    expect(secretEnvironmentOutputValues(null, ["ANY"])).toEqual([]);
  });

  it("adds trimmed, JSON-escaped, and per-line forms of a multi-line value", () => {
    const value = "-----BEGIN SYNTHETIC KEY-----\nline-one-synthetic\r\nline-two \"quoted\"\n-----END SYNTHETIC KEY-----\n";
    const values = secretEnvironmentOutputValues({ MULTI: value }, ["MULTI"]);
    expect(values).toContain(value);
    expect(values).toContain(value.trim());
    expect(values).toContain(JSON.stringify(value).slice(1, -1));
    expect(values).toContain("line-one-synthetic");
    expect(values).toContain("line-two \"quoted\"");
    expect(values).toContain("line-two \\\"quoted\\\"");
    expect(values).not.toContain("-----BEGIN SYNTHETIC KEY-----");
    expect(values).toEqual([...values].sort((a, b) => b.length - a.length));
  });
});

describe("agent output redactor with secret values", () => {
  it("masks a value that contains another secret without leaking either", () => {
    const outer = "outer-synthetic-secret-inner-value";
    const inner = "inner-value";
    const redactor = createAgentIdentityRedactor(undefined,
      secretEnvironmentOutputValues({ OUTER: outer, INNER: inner }, ["OUTER", "INNER"]));
    const text = `env: OUTER=${outer} INNER=${inner}`;
    expect(redactor.redact(text)).toBe(`env: OUTER=${REDACTED} INNER=${REDACTED}`);
  });

  it("masks a secret split across streamed chunks and keeps plain output", () => {
    const secret = "sk_test_synthetic_streamed_value";
    const redactor = createAgentIdentityRedactor(undefined, secretEnvironmentOutputValues({ KEY: secret }, ["KEY"]));
    const output = [
      redactor.chunk("stdout", `PLAIN=visible KEY=${secret.slice(0, 10)}`),
      redactor.chunk("stdout", `${secret.slice(10)}\ndone\n`),
      redactor.finish("stdout"),
    ].join("");
    expect(output).toBe(`PLAIN=visible KEY=${REDACTED}\ndone\n`);
  });

  it("masks each line when a multi-line value is printed without its line breaks", () => {
    const value = "first-synthetic-line\nsecond-synthetic-line";
    const redactor = createAgentIdentityRedactor(undefined, secretEnvironmentOutputValues({ MULTI: value }, ["MULTI"]));
    expect(redactor.redact("echo: first-synthetic-line second-synthetic-line"))
      .toBe(`echo: ${REDACTED} ${REDACTED}`);
    expect(redactor.redact(JSON.stringify({ output: value }))).toBe(JSON.stringify({ output: REDACTED }));
  });
});
