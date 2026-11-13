import { describe, expect, it } from "vitest";
import { createAgentIdentityRedactor, secretEnvironmentValues, secretOutputForms } from "./agent-identity-redaction.js";

const REDACTED = "***REDACTED***";

function streamed(redactor: ReturnType<typeof createAgentIdentityRedactor>, chunks: string[]) {
  return chunks.map((chunk) => redactor.chunk("stdout", chunk)).join("") + redactor.finish("stdout");
}

describe("secret environment values", () => {
  it("selects only secret-bound values and leaves plain values alone", () => {
    expect(secretEnvironmentValues({
      STRIPE_KEY: "sk_test_synthetic_0123456789",
      PLAIN_URL: "https://plain.example.test/api",
      EMPTY: "",
      NUMBER: 12345678,
    }, new Set(["STRIPE_KEY", "EMPTY", "NUMBER", "MISSING"]))).toEqual(["sk_test_synthetic_0123456789"]);
    expect(secretEnvironmentValues(null, ["ANY"])).toEqual([]);
  });

  it("skips forms shorter than the minimum length and whitespace-only values", () => {
    expect(secretOutputForms(["abc1234", "x", "            ", "  abc  "])).toEqual([]);
    expect(secretOutputForms(["abcd1234"])).toEqual(["abcd1234"]);
  });

  it("adds trimmed, JSON-escaped, and per-line forms of a multi-line value", () => {
    const value = "-----BEGIN SYNTHETIC KEY-----\nline-one-synthetic\r\nline-two \"quoted\"\n-----END SYNTHETIC KEY-----\n";
    const forms = secretOutputForms([value]);
    expect(forms).toContain(value);
    expect(forms).toContain(value.trim());
    expect(forms).toContain(JSON.stringify(value).slice(1, -1));
    expect(forms).toContain("line-one-synthetic");
    expect(forms).toContain("line-two \"quoted\"");
    expect(forms).toContain("line-two \\\"quoted\\\"");
    expect(forms).not.toContain("-----BEGIN SYNTHETIC KEY-----");
    expect(forms).toEqual([...forms].sort((a, b) => b.length - a.length));
  });
});

describe("agent output redactor with secret values", () => {
  it("masks a value that contains another secret without leaking either", () => {
    const outer = "outer-synthetic-secret-inner-value";
    const inner = "inner-value";
    const redactor = createAgentIdentityRedactor(undefined, [outer, inner]);
    expect(redactor.redact(`env: OUTER=${outer} INNER=${inner}`)).toBe(`env: OUTER=${REDACTED} INNER=${REDACTED}`);
  });

  it("holds a possible longer secret before it masks a shorter secret at the same position", () => {
    const redactor = createAgentIdentityRedactor(undefined, ["abcdefgh", "abcdefgh1234567890"]);
    expect(streamed(redactor, ["KEY=abcdefgh", "1234567890\n"])).toBe(`KEY=${REDACTED}\n`);
    expect(streamed(redactor, ["KEY=abcdefgh", "-other\n"])).toBe(`KEY=${REDACTED}-other\n`);
    expect(streamed(redactor, ["A=abcdefgh B=abcdefgh123", "4567890 C=abcdefgh"])).toBe(`A=${REDACTED} B=${REDACTED} C=${REDACTED}`);
  });

  it("masks a secret split across streamed chunks and keeps plain output", () => {
    const secret = "sk_test_synthetic_streamed_value";
    const redactor = createAgentIdentityRedactor(undefined, [secret]);
    expect(streamed(redactor, [`PLAIN=visible KEY=${secret.slice(0, 10)}`, `${secret.slice(10)}\ndone\n`]))
      .toBe(`PLAIN=visible KEY=${REDACTED}\ndone\n`);
    for (let split = 1; split < secret.length; split++) {
      expect(streamed(redactor, [`x${secret.slice(0, split)}`, `${secret.slice(split)}y`])).toBe(`x${REDACTED}y`);
    }
  });

  it("masks each line when a multi-line value is printed without its line breaks", () => {
    const value = "first-synthetic-line\nsecond-synthetic-line";
    const redactor = createAgentIdentityRedactor(undefined, [value]);
    expect(redactor.redact("echo: first-synthetic-line second-synthetic-line")).toBe(`echo: ${REDACTED} ${REDACTED}`);
    expect(redactor.redact(JSON.stringify({ output: value }))).toBe(JSON.stringify({ output: REDACTED }));
  });

  it("keeps protocol fields unchanged when a secret equals a protocol word", () => {
    const redactor = createAgentIdentityRedactor(undefined, ["completed", "succeeded", "commandExecution", "item-secret-id"]);
    const event = {
      schema: "paperclip.prp.event.v1", eventType: "turn.completed", itemId: "item-secret-id",
      payload: { kind: "commandExecution", status: "completed", text: "the command completed", output: "commandExecution done" },
      terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded" },
    };
    expect(redactor.redact(event)).toEqual({
      ...event,
      payload: { kind: "commandExecution", status: "completed", text: `the command ${REDACTED}`, output: `${REDACTED} done` },
    });
  });

  it("keeps delta protocol fields while it masks streamed output", () => {
    const redactor = createAgentIdentityRedactor(undefined, ["commandExecution"]);
    const first = redactor.delta("turn:item", { itemId: "item", kind: "commandExecution", text: "run commandExec" }, "item");
    expect(first).toEqual({ itemId: "item", kind: "commandExecution", text: "run " });
    const settled = redactor.settleDeltas("turn:item", { itemId: "item" }, false);
    expect(settled).toEqual({ itemId: "item", outputTails: [{ itemId: "item", payload: { itemId: "item", kind: "commandExecution", text: REDACTED } }] });
  });

  it("masks the rest of a secret that a new redactor receives after a restart", () => {
    const secret = "abcdefgh1234567890";
    const before = createAgentIdentityRedactor(undefined, [secret], { maskResumedSuffixes: true });
    expect(before.chunk("item", "echo abcdefgh")).toBe("echo ");
    const after = createAgentIdentityRedactor(undefined, [secret], { maskResumedSuffixes: true });
    expect(after.chunk("item", "1234567890 done") + after.finish("item")).toBe(`${REDACTED} done`);
    expect(after.chunk("item", " 1234567890")).toBe(" 1234567890");
    const inside = createAgentIdentityRedactor(undefined, [secret], { maskResumedSuffixes: true });
    expect(inside.chunk("item", "3456") + inside.chunk("item", "7890 next") + inside.finish("item")).toBe(`${REDACTED}${REDACTED} next`);
    const pem = createAgentIdentityRedactor(undefined, ["-----BEGIN SYNTHETIC-----\nbody-line-synthetic-0123456789\n-----END SYNTHETIC-----"],
      { maskResumedSuffixes: true });
    expect(pem.chunk("item", "body-line-syn") + pem.chunk("item", "thetic-0123456789 x") + pem.finish("item")).toBe(`${REDACTED} x`);
    const fresh = createAgentIdentityRedactor(undefined, [secret], { maskResumedSuffixes: true });
    expect(fresh.chunk("item", "hello 7890") + fresh.finish("item")).toBe("hello 7890");
    const overlapping = createAgentIdentityRedactor(undefined, ["old-prefix-XYZabcdefgh", secret], { maskResumedSuffixes: true });
    expect(overlapping.chunk("item", "XYZabcdefgh1234567890 done") + overlapping.finish("item")).toBe(`${REDACTED} done`);
    const heldInside = createAgentIdentityRedactor(undefined, ["old-prefix-XYZabcdefgh", secret], { maskResumedSuffixes: true });
    expect(heldInside.chunk("item", "XYZabcdefgh123") + heldInside.chunk("item", "4567890 done") + heldInside.finish("item"))
      .toBe(`${REDACTED}${REDACTED} done`);
    const diverging = createAgentIdentityRedactor(undefined, ["old-prefix-XYZabcdefgh", secret], { maskResumedSuffixes: true });
    expect(diverging.chunk("item", "XYZabcdefgh123") + diverging.chunk("item", " other") + diverging.finish("item"))
      .not.toContain("XYZabcdefgh");
    const ending = createAgentIdentityRedactor(undefined, ["old-prefix-XYZabcdef", "abcdefghij"], { maskResumedSuffixes: true });
    expect(ending.chunk("item", "XYZabcdef") + ending.finish("item")).toBe(`${REDACTED}${REDACTED}`);
    const continuing = createAgentIdentityRedactor(undefined, ["old-prefix-XYZabcdef", "abcdefghij"], { maskResumedSuffixes: true });
    expect(continuing.chunk("item", "XYZabcdef") + continuing.chunk("item", "ghij done") + continuing.finish("item"))
      .toBe(`${REDACTED}${REDACTED} done`);
    const shortCarry = createAgentIdentityRedactor(undefined, ["old-prefix-XYZabc", "abcdefghij"], { maskResumedSuffixes: true });
    expect(shortCarry.chunk("item", "XYZabc") + shortCarry.chunk("item", "x tail") + shortCarry.finish("item"))
      .toBe(`${REDACTED}${REDACTED}x tail`);
    const bytes = createAgentIdentityRedactor(undefined, [secret], { maskResumedSuffixes: true });
    expect(["1", "2", "3", "4", "567890 done"].map((piece) => bytes.chunk("item", piece)).join("") + bytes.finish("item"))
      .toBe(`${REDACTED}${REDACTED} done`);
    const shortItem = createAgentIdentityRedactor(undefined, [secret], { maskResumedSuffixes: true });
    expect(shortItem.chunk("item", "12") + shortItem.finish("item")).toBe("12");
    const local = createAgentIdentityRedactor(undefined, [secret]);
    expect(local.chunk("item", "1234567890 done") + local.finish("item")).toBe("1234567890 done");
  });

  it("adds the secrets of a later attempt without dropping earlier ones", () => {
    const redactor = createAgentIdentityRedactor(undefined, ["sk_test_original_value"]);
    redactor.addSecretValues(["sk_test_rotated_value", "sk_test_original_value"]);
    expect(redactor.secretSources).toEqual(["sk_test_original_value", "sk_test_rotated_value"]);
    expect(redactor.redact("a=sk_test_original_value b=sk_test_rotated_value")).toBe(`a=${REDACTED} b=${REDACTED}`);
  });
});
