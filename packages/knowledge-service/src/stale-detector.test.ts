import { describe, it, expect } from "vitest";
import {
  parseStaleTriggers,
  extractUniqueTopicSlugs,
  hasStaleTrigger,
} from "./stale-detector.js";

describe("stale-detector", () => {
  describe("parseStaleTriggers", () => {
    it("parses single stale trigger", () => {
      const text = "Agent heartbeat with [KNOWLEDGE-STALE] topic=stripe";
      const triggers = parseStaleTriggers(text);

      expect(triggers).toHaveLength(1);
      expect(triggers[0].topicSlug).toBe("stripe");
      expect(triggers[0].command).toBe("[KNOWLEDGE-STALE] topic=stripe");
    });

    it("parses multiple stale triggers in same text", () => {
      const text =
        "[KNOWLEDGE-STALE] topic=clerk and also [KNOWLEDGE-STALE] topic=stripe";
      const triggers = parseStaleTriggers(text);

      expect(triggers).toHaveLength(2);
      expect(triggers[0].topicSlug).toBe("clerk");
      expect(triggers[1].topicSlug).toBe("stripe");
    });

    it("handles case-insensitive command matching", () => {
      const text = "[knowledge-stale] topic=nextjs";
      const triggers = parseStaleTriggers(text);

      expect(triggers).toHaveLength(1);
      expect(triggers[0].topicSlug).toBe("nextjs");
    });

    it("handles uppercase topic slug in command", () => {
      const text = "[KNOWLEDGE-STALE] topic=DOKPLOY";
      const triggers = parseStaleTriggers(text);

      expect(triggers).toHaveLength(1);
      expect(triggers[0].topicSlug).toBe("dokploy");
    });

    it("returns empty array when no triggers found", () => {
      const text = "Just a regular heartbeat without any stale triggers";
      const triggers = parseStaleTriggers(text);

      expect(triggers).toHaveLength(0);
    });

    it("captures correct start and end indices", () => {
      const text = "prefix [KNOWLEDGE-STALE] topic=clerk suffix";
      const triggers = parseStaleTriggers(text);

      expect(triggers).toHaveLength(1);
      expect(triggers[0].startIndex).toBe(7);
      expect(triggers[0].endIndex).toBe(36);
    });

    it("handles whitespace variations", () => {
      const text = "[KNOWLEDGE-STALE] topic=typescript   ";
      const triggers = parseStaleTriggers(text);

      expect(triggers).toHaveLength(1);
      expect(triggers[0].topicSlug).toBe("typescript");
    });

    it("parses topic slug with hyphens", () => {
      const text = "[KNOWLEDGE-STALE] topic=my-topic-name";
      const triggers = parseStaleTriggers(text);

      expect(triggers).toHaveLength(1);
      expect(triggers[0].topicSlug).toBe("my-topic-name");
    });

    it("parses topic slug with numbers", () => {
      const text = "[KNOWLEDGE-STALE] topic=nextjs13";
      const triggers = parseStaleTriggers(text);

      expect(triggers).toHaveLength(1);
      expect(triggers[0].topicSlug).toBe("nextjs13");
    });
  });

  describe("extractUniqueTopicSlugs", () => {
    it("returns unique slugs only", () => {
      const text =
        "[KNOWLEDGE-STALE] topic=clerk and [KNOWLEDGE-STALE] topic=clerk";
      const slugs = extractUniqueTopicSlugs(text);

      expect(slugs).toEqual(["clerk"]);
    });

    it("returns empty array when no triggers", () => {
      const slugs = extractUniqueTopicSlugs("no triggers here");
      expect(slugs).toEqual([]);
    });

    it("deduplicates case variations to lowercase", () => {
      const text =
        "[KNOWLEDGE-STALE] topic=Clerk and [KNOWLEDGE-STALE] topic=CLERK";
      const slugs = extractUniqueTopicSlugs(text);

      expect(slugs).toEqual(["clerk"]);
    });
  });

  describe("hasStaleTrigger", () => {
    it("returns true when trigger exists", () => {
      expect(hasStaleTrigger("[KNOWLEDGE-STALE] topic=stripe")).toBe(true);
    });

    it("returns false when no trigger", () => {
      expect(hasStaleTrigger("regular heartbeat")).toBe(false);
    });

    it("is case insensitive", () => {
      expect(hasStaleTrigger("[knowledge-stale] topic=test")).toBe(true);
    });
  });
});
