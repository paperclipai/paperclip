import { describe, expect, it } from "vitest";
import {
  buildMissionContractDocumentFromOptions,
  collectRepeatableOption,
} from "../commands/client/issue-mission.js";

describe("issue mission helpers", () => {
  it("builds a canonical mission document from CLI options", () => {
    const document = buildMissionContractDocumentFromOptions({
      request: "Ensure /belly-trip creates the couple itinerary and map pins",
      scope: ["route:/belly-trip", "route:/trips"],
      acceptance: [
        "Generated itinerary appears in /trips",
        "Map pins render for every planned stop",
      ],
      gates: "implementation,review,qa,release,production_smoke",
    });

    expect(document.key).toBe("mission");
    expect(document.title).toBe("Mission Contract");
    expect(document.body).toContain("\"donePolicy\": \"all_required_gates_passed\"");
  });

  it("collects repeatable commander options without mutating the previous list", () => {
    const first = collectRepeatableOption("route:/trips");
    const second = collectRepeatableOption("route:/belly-trip", first);

    expect(first).toEqual(["route:/trips"]);
    expect(second).toEqual(["route:/trips", "route:/belly-trip"]);
  });
});
