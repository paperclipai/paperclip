import { describe, expect, it } from "vitest";
import { isEspoRecordId } from "./espo-record-id.js";

describe("isEspoRecordId", () => {
  it("recognizes native 17-character Espo record ids", () => {
    expect(isEspoRecordId("6a3b62020947897c2")).toBe(true);
  });

  it("keeps compatibility with UUID-shaped ids", () => {
    expect(isEspoRecordId("6a4ddca1-6eae-4ae8-9abc-1234567890ab")).toBe(true);
  });

  it("does not mistake venue names for record ids", () => {
    expect(isEspoRecordId("Gasthaus Bären Kölliken")).toBe(false);
  });
});
