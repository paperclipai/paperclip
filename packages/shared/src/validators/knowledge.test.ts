import { describe, expect, it } from "vitest";
import { KNOWLEDGE_NOTE_BODY_MAX_BYTES } from "../constants.js";
import {
  createKnowledgeItemSchema,
  updateKnowledgeItemSchema,
} from "./knowledge.js";

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

describe("knowledge validators", () => {
  it("accepts note bodies at the byte-size cap", () => {
    const bodyAtLimit = "😀".repeat(KNOWLEDGE_NOTE_BODY_MAX_BYTES / 4);
    expect(utf8ByteLength(bodyAtLimit)).toBe(KNOWLEDGE_NOTE_BODY_MAX_BYTES);

    const created = createKnowledgeItemSchema.safeParse({
      title: "Sized note",
      kind: "note",
      summary: null,
      body: bodyAtLimit,
    });

    expect(created.success).toBe(true);
  });

  it("rejects note bodies larger than the byte-size cap", () => {
    const oversizedBody = "😀".repeat(Math.floor(KNOWLEDGE_NOTE_BODY_MAX_BYTES / 4) + 1);
    expect(utf8ByteLength(oversizedBody)).toBeGreaterThan(KNOWLEDGE_NOTE_BODY_MAX_BYTES);

    const created = createKnowledgeItemSchema.safeParse({
      title: "Large note",
      kind: "note",
      summary: null,
      body: oversizedBody,
    });
    expect(created.success).toBe(false);

    const updated = updateKnowledgeItemSchema.safeParse({
      body: oversizedBody,
    });
    expect(updated.success).toBe(false);
  });
});
