import { describe, expect, it } from "vitest";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";

describe("native PRP envelope validation", () => {
  it("accepts matching v1 and v2 envelopes", () => {
    expect(
      isValidNativePrpEnvelope(
        { schema: "paperclip.prp.event.v1", schemaVersion: 1 },
        1,
      ),
    ).toBe(true);
    expect(
      isValidNativePrpEnvelope(
        { schema: "paperclip.prp.event.v2", schemaVersion: 2 },
        2,
      ),
    ).toBe(true);
  });

  it("rejects malformed and mismatched envelopes", () => {
    expect(
      isValidNativePrpEnvelope(
        { schema: "paperclip.prp.event.v2", schemaVersion: 2 },
        1,
      ),
    ).toBe(false);
    expect(
      isValidNativePrpEnvelope(
        { schema: "paperclip.prp.event.v2", schemaVersion: 99 },
        99,
      ),
    ).toBe(false);
  });
});
