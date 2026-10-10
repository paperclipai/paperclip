import { describe, expect, it } from "vitest";
import { museCommandSchema, museQuerySchema } from "./muse-protocol.js";

const assignmentId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const operation = { version: 1, assignmentId, requestId };
const questionSet = {
  schema: "paperclip.question_set.v1",
  questions: [{ id: "answer", prompt: "What should happen next?", required: true, answerMode: "text" }],
};
const nativeRequestEnvelopes = [
  {
    name: "request_user_input",
    validate: (nativeRequestId: string) => museCommandSchema.safeParse({
      ...operation, command: "request_user_input", nativeRequestId, questionSet,
    }),
  },
  {
    name: "consume_input",
    validate: (nativeRequestId: string) => museCommandSchema.safeParse({
      ...operation, command: "consume_input", nativeRequestId,
      inputDigest: `sha256:${"a".repeat(64)}`,
      continuationReceiptId: "00000000-0000-4000-8000-000000000003",
      continuationPersisted: true,
    }),
  },
  {
    name: "input.pending",
    validate: (nativeRequestId: string) => museQuerySchema.safeParse({
      version: 1, query: "input.pending", assignmentId, nativeRequestId,
    }),
  },
];

describe("Muse native request identity bounds", () => {
  it.each(nativeRequestEnvelopes)("accepts the 160-byte ASCII boundary for $name", ({ validate }) => {
    expect(validate("Ab09._:-".repeat(20)).success).toBe(true);
  });

  it.each(nativeRequestEnvelopes)("rejects identities Runner cannot accept for $name", ({ validate }) => {
    for (const value of ["", "a".repeat(161), "request id", "request/1", "é", "回答", "request\n", "request\u0000"]) {
      expect(validate(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe("Muse progress UTF-8 bounds", () => {
  const validate = (text: string) => museCommandSchema.safeParse({ ...operation, command: "progress", text });

  it("accepts exactly 12000 ASCII bytes and rejects the next byte", () => {
    expect(validate("a".repeat(12000)).success).toBe(true);
    expect(validate("a".repeat(12001)).success).toBe(false);
  });

  it.each(["é", "答", "😀"])("bounds %s by UTF-8 bytes rather than JavaScript length", (character) => {
    const bytes = new TextEncoder().encode(character).byteLength;
    const boundary = character.repeat(12000 / bytes);
    expect(validate(boundary).success).toBe(true);
    expect(validate(`${boundary}a`).success).toBe(false);
  });

  it("retains trimmed text semantics at the byte boundary and rejects blank text", () => {
    const text = "é".repeat(6000);
    const parsed = validate(` \n${text}\t `);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.command === "progress") expect(parsed.data.text).toBe(text);
    expect(validate(" \n\t ").success).toBe(false);
  });
});
