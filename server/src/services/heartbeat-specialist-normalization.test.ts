import { describe, expect, it } from "vitest";
import { normalizeUnavailableSpecialistLaneStatus } from "./heartbeat.js";

describe("normalizeUnavailableSpecialistLaneStatus", () => {
  it("demotes in_review specialist lanes back to todo", () => {
    expect(normalizeUnavailableSpecialistLaneStatus("in_review")).toBe("todo");
  });

  it("preserves already queued specialist lanes", () => {
    expect(normalizeUnavailableSpecialistLaneStatus("todo")).toBe("todo");
    expect(normalizeUnavailableSpecialistLaneStatus("blocked")).toBe("blocked");
  });
});
