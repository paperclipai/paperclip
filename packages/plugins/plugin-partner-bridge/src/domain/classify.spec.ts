import { describe, expect, it } from "vitest";
import { classifyItem } from "./classify.js";
import type { ChannelItem } from "../types.js";

const item = (body: string, metadata?: Record<string, unknown>): ChannelItem => ({
  id: "c", companyId: "A", issueId: "i", kind: "msg", body, ts: "t", metadata,
});

describe("classifyItem", () => {
  it("explicit [COMMITMENT] prefix -> commitment", () => {
    expect(classifyItem(item("[COMMITMENT] kickoff signature"))).toBe("commitment");
  });
  it("plain status message -> routine", () => {
    expect(classifyItem(item("brief transmis pour revue, merci"))).toBe("routine");
  });
  it("explicit metadata class:commitment -> commitment", () => {
    expect(classifyItem(item("anything", { class: "commitment" }))).toBe("commitment");
  });
  it("heuristic keyword (budget / signature / contrat / €) -> commitment", () => {
    expect(classifyItem(item("merci de valider le budget"))).toBe("commitment");
    expect(classifyItem(item("prêt pour signature du contrat"))).toBe("commitment");
    expect(classifyItem(item("devis à 18 000 €"))).toBe("commitment");
  });
  it("ambiguous (empty/whitespace) -> commitment (fail-safe)", () => {
    expect(classifyItem(item("   "))).toBe("commitment");
  });
  it("explicit metadata class:routine -> routine (overrides heuristic)", () => {
    expect(classifyItem(item("budget 20k€ contrat", { class: "routine" }))).toBe("routine");
  });
});
