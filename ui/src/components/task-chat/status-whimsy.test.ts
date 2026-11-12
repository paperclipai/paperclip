import { describe, expect, it } from "vitest";
import {
  ANALOG_OFFICE_WORDS,
  CLAUDE_CODE_WORDS,
  WHIMSY_ROTATE_MS,
  WHIMSY_WORDS,
  isGenericStatusLabel,
  whimsyWord,
} from "./status-whimsy";

describe("whimsy word pools", () => {
  it("always includes the Clipping brand nod in the analog-office pool", () => {
    expect(ANALOG_OFFICE_WORDS).toContain("Clipping");
    expect(WHIMSY_WORDS).toContain("Clipping");
  });

  it("keeps the pools unique and analog-office dominant (round-2 curation)", () => {
    expect(new Set(WHIMSY_WORDS).size).toBe(WHIMSY_WORDS.length);
    expect(WHIMSY_WORDS.length).toBe(ANALOG_OFFICE_WORDS.length + CLAUDE_CODE_WORDS.length);
    expect(ANALOG_OFFICE_WORDS.length).toBeGreaterThan(CLAUDE_CODE_WORDS.length);
  });

  it("holds only the four board-kept Claude-Code words", () => {
    expect([...CLAUDE_CODE_WORDS]).toEqual(["Brewing", "Tinkering", "Distilling", "Deliberating"]);
  });

  it("applies the round-2 analog-office edits", () => {
    for (const removed of ["Cataloguing", "Carbon-copying", "Archiving"]) {
      expect(ANALOG_OFFICE_WORDS).not.toContain(removed);
    }
    for (const added of [
      "Trimming",
      "Aligning",
      "Combining",
      "Whiteboarding",
      "Diagramming",
      "Sketching",
      "Labeling",
      "Sticky-noting",
    ]) {
      expect(ANALOG_OFFICE_WORDS).toContain(added);
    }
    // "Grepping" is an informative taxonomy verb, never random whimsy.
    expect(WHIMSY_WORDS).not.toContain("Grepping");
  });

  it("keeps every word a gerund so it reads sensibly after-the-fact", () => {
    for (const word of WHIMSY_WORDS) expect(word).toMatch(/^[A-Z][a-z]+(?:-[a-z]+)*ing$/);
  });
});

describe("isGenericStatusLabel", () => {
  it("flags only the signal-free labels", () => {
    expect(isGenericStatusLabel("Running")).toBe(true);
    expect(isGenericStatusLabel("Working")).toBe(true);
    expect(isGenericStatusLabel("running")).toBe(true);
  });

  it("keeps informative copy untouched", () => {
    for (const label of ["Queued", "Thinking", "Responding", "Running a command", "Searching", "", undefined]) {
      expect(isGenericStatusLabel(label)).toBe(false);
    }
  });
});

describe("whimsyWord", () => {
  it("picks deterministically from the seed", () => {
    expect(whimsyWord("run-1:status")).toBe(whimsyWord("run-1:status"));
    expect(whimsyWord("run-1:status", 0)).toBe(whimsyWord("run-1:status", WHIMSY_ROTATE_MS - 1));
  });

  it("rotates to the next word every rotation interval", () => {
    const first = whimsyWord("run-1:status", 0);
    const second = whimsyWord("run-1:status", WHIMSY_ROTATE_MS);
    const index = WHIMSY_WORDS.indexOf(first);
    expect(second).toBe(WHIMSY_WORDS[(index + 1) % WHIMSY_WORDS.length]);
    expect(second).not.toBe(first);
  });

  it("cycles through the whole pool and wraps", () => {
    const seen = new Set<string>();
    for (let tick = 0; tick < WHIMSY_WORDS.length; tick++) {
      seen.add(whimsyWord("run-1:status", tick * WHIMSY_ROTATE_MS));
    }
    expect(seen.size).toBe(WHIMSY_WORDS.length);
    expect(whimsyWord("run-1:status", WHIMSY_WORDS.length * WHIMSY_ROTATE_MS)).toBe(
      whimsyWord("run-1:status", 0),
    );
  });

  it("spreads different seeds across the pool", () => {
    const words = new Set(
      Array.from({ length: 20 }, (_, i) => whimsyWord(`run-${i}:status`)),
    );
    expect(words.size).toBeGreaterThan(5);
  });
});
