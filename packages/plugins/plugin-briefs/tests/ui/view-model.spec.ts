import { describe, expect, it } from "vitest";
import {
  countAttention,
  formatRelative,
  groupCardsIntoSections,
  sectionForState,
  sortBriefCards,
  stateBadgeLabel,
  stateTone,
} from "../../src/ui/view-model.js";
import { gallery, makeCard, resetFixtureIds } from "./fixtures.js";

describe("Briefs view model", () => {
  it("maps every state to a defined badge label and tone", () => {
    for (const state of Object.keys(stateBadgeLabel) as Array<keyof typeof stateBadgeLabel>) {
      expect(stateBadgeLabel[state]).toBeTruthy();
      expect(stateTone[state]).toBeTruthy();
    }
  });

  it("sorts visible cards into one pinned-then-recent list", () => {
    resetFixtureIds();
    const cards = sortBriefCards(gallery());

    expect(cards.map((c) => c.title)).toEqual([
      "Briefs plugin planning",
      "External-adapter plugin: spec review",
      "Sandbox runner crash loop",
      "Cost dashboard improvements",
      "Release readiness",
      "Sidebar plugin slot hardening",
      "Onboarding flow fixes",
      "GA migration spike",
    ]);
  });

  it("counts attention cards across error/blocked/waiting-user/waiting-reviewer", () => {
    expect(countAttention(gallery())).toBe(4);
  });

  it("excludes hidden cards from sections", () => {
    const cards = [makeCard({ title: "Hidden one", hidden: true })];
    const sections = groupCardsIntoSections(cards);
    for (const s of sections) expect(s.cards).toHaveLength(0);
    expect(sortBriefCards(cards)).toHaveLength(0);
  });

  it("classifies states using the precedence buckets", () => {
    expect(sectionForState("error")).toBe("attention");
    expect(sectionForState("blocked")).toBe("attention");
    expect(sectionForState("waiting-user")).toBe("attention");
    expect(sectionForState("waiting-reviewer")).toBe("live");
    expect(sectionForState("live")).toBe("live");
    expect(sectionForState("done")).toBe("settled");
    expect(sectionForState("stale")).toBe("settled");
  });

  it("formats relative times in compact form", () => {
    const now = new Date("2026-05-22T10:00:00.000Z");
    expect(formatRelative("2026-05-22T09:45:00.000Z", now)).toBe("15m ago");
    expect(formatRelative("2026-05-22T03:00:00.000Z", now)).toBe("7h ago");
    expect(formatRelative("2026-05-20T10:00:00.000Z", now)).toBe("2d ago");
    expect(formatRelative(null, now)).toBe("");
  });
});
