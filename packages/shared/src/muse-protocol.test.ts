import { describe, expect, it } from "vitest";
import { MUSE_ASSET_VERSION, MUSE_CLIENT_VERSION, MUSE_PUBLIC_ROUTES, museCommandSchema, musePairSchema, museQuerySchema } from "./muse-protocol.js";
import { paperclipQuestionSetPayloadSchema } from "./validators/issue.js";

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
    for (const value of ["", "a".repeat(161), "request id", "request/1", "é", "回答", "request\n", "request\u0000", ".question", "_question", ":question", "-question"]) {
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


it("keeps installed-version declarations finite and backward compatible", () => {
  expect(MUSE_ASSET_VERSION).toBe(9);
  expect(MUSE_CLIENT_VERSION).toBe("9");
  expect(museQuerySchema.parse({ version: 1, query: "identify" })).toEqual({ version: 1, query: "identify" });
  for (const clientVersion of ["2", "3", "4", "5", "6", "7", "8", "9"]) {
    expect(museQuerySchema.parse({ version: 1, query: "identify", clientVersion })).toMatchObject({ clientVersion });
    expect(musePairSchema.parse({ version: 1, ticket: "synthetic-unused-ticket", clientVersion })).toMatchObject({ clientVersion });
  }
  for (const clientVersion of ["1", "10"]) {
    expect(() => museQuerySchema.parse({ version: 1, query: "identify", clientVersion })).toThrow();
    expect(() => musePairSchema.parse({ version: 1, ticket: "synthetic-unused-ticket", clientVersion })).toThrow();
  }
});

it("exposes only the exact immutable asset paths for all nine versions", () => {
  expect(MUSE_PUBLIC_ROUTES).toHaveLength(48);
  expect(new Set(MUSE_PUBLIC_ROUTES.map(({ method, path }) => `${method} ${path}`)).size).toBe(48);
  expect(MUSE_PUBLIC_ROUTES.filter(({ path }) => path.includes("/assets/"))).toEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((version) => ["manifest.json", "client.py", "detector.sh", "instructions.md"].map((name) => ({
      method: "GET", path: `/api/muse/v1/assets/${version}/${name}`,
    }))),
  );
});

describe("Muse native question-set durable byte bound", () => {
  const encoder = new TextEncoder();
  const validate = (questionSet: unknown) => museCommandSchema.safeParse({
    ...operation, command: "request_user_input", nativeRequestId: "scope-01", questionSet,
  });
  const body = (initialText: string) => ({ ...questionSet, title: "t".repeat(1000),
    description: "d".repeat(100000), questions: [{ ...questionSet.questions[0], initialText }] });

  it("accepts the exact serialized 196 KiB boundary and rejects one more byte", () => {
    const length = 196 * 1024 - encoder.encode(JSON.stringify(body(""))).byteLength;
    const boundary = body("a".repeat(length));
    expect(encoder.encode(JSON.stringify(boundary))).toHaveLength(196 * 1024);
    expect(validate(boundary).success).toBe(true);
    expect(validate(body("a".repeat(length + 1))).success).toBe(false);
  });

  it.each(["é", "答", "😀", "\n", '"'])("counts UTF-8 and JSON escaping for %s", character => {
    const budget = 196 * 1024 - encoder.encode(JSON.stringify(body(""))).byteLength;
    const unit = encoder.encode(JSON.stringify(character)).byteLength - 2;
    const count = Math.floor(budget / unit), padding = "a".repeat(budget % unit);
    expect(validate(body(character.repeat(count) + padding)).success).toBe(true);
    expect(validate(body(character.repeat(count) + padding + "a")).success).toBe(false);
  });
});

describe("Muse bridge-supported question admission", () => {
  const validate = (questionSet: unknown) => museCommandSchema.safeParse({
    ...operation, command: "request_user_input", nativeRequestId: "1question._:-", questionSet,
  });

  it.each(["^[0-9]+$", "", "(a+)+$"])("rejects provider pattern %j while the generic canonical form remains valid", pattern => {
    const payload = { ...questionSet, questions: [{ ...questionSet.questions[0], textValidation: { pattern } }] };
    expect(paperclipQuestionSetPayloadSchema.safeParse(payload).success).toBe(true);
    expect(validate(payload).success).toBe(false);
  });

  it.each([{ minLength: 2, maxLength: 1 }, { minimum: 2, maximum: 1 }])("rejects conflicting canonical bounds %j", textValidation => {
    expect(validate({ ...questionSet, questions: [{ ...questionSet.questions[0], textValidation }] }).success).toBe(false);
  });

  it("preserves independent question and option identities plus supported text and choice forms", () => {
    const payload = { ...questionSet, questions: [
      { id: ".question", prompt: "Amount?", required: true, answerMode: "text", initialText: "2",
        textValidation: { inputType: "integer", minLength: 0, maxLength: 3, minimum: 1, maximum: 10 } },
      { id: "é choice", prompt: "Choose", required: false, answerMode: "single_select",
        options: [{ id: "_option", label: "Test" }, { id: "option space", label: "Production" }], customAnswer: { enabled: true } },
    ] };
    const result = validate(payload);
    expect(result.success).toBe(true);
    if (result.success && result.data.command === "request_user_input") expect(result.data.questionSet).toEqual(payload);
  });
});
