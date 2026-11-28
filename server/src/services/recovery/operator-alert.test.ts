import { describe, expect, it } from "vitest";
import { formatOperatorAlertMentions } from "./operator-alert.js";

describe("formatOperatorAlertMentions", () => {
  it("mentions the CEO agent and company operators without duplicates", () => {
    expect(
      formatOperatorAlertMentions({
        ceo: { id: "ceo-1", name: "Bookie" },
        users: [
          { id: "lloyd", name: "Lloyd" },
          { id: "lloyd", name: "Lloyd" },
          { id: "chris", name: "Chris" },
        ],
      }),
    ).toBe("[Bookie](agent://ceo-1) [Lloyd](user://lloyd) [Chris](user://chris)");
  });

  it("returns an empty string when no operators are known", () => {
    expect(formatOperatorAlertMentions({ ceo: null, users: [] })).toBe("");
    expect(formatOperatorAlertMentions({ users: [{ id: "  ", name: "Skip" }] })).toBe("");
  });
});
