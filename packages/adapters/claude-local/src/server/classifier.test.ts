import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CLASSIFIER_VERSION,
  isRecoverable,
  type ClassifierInput,
  type RecoverabilityReason,
} from "./classifier.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "classifier");

interface Fixture {
  name: string;
  input: ClassifierInput;
  expected: {
    recoverable: boolean;
    reason: RecoverabilityReason;
    matchContains: string | null;
  };
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Fixture);
}

describe("classifier", () => {
  it("CLASSIFIER_VERSION is stable", () => {
    expect(CLASSIFIER_VERSION).toBe("1.0.0");
  });

  const fixtures = loadFixtures();

  it("loaded the expected number of fixtures", () => {
    // Catches accidental fixture deletion / misnaming.
    expect(fixtures.length).toBeGreaterThanOrEqual(19);
  });

  for (const fx of fixtures) {
    it(`fixture ${fx.name}: classifies as ${fx.expected.reason} (recoverable=${fx.expected.recoverable})`, () => {
      const verdict = isRecoverable(fx.input);
      expect(verdict.reason).toBe(fx.expected.reason);
      expect(verdict.recoverable).toBe(fx.expected.recoverable);
      if (fx.expected.matchContains == null) {
        // null match permitted for timeout/ok cases
      } else {
        expect(verdict.match).not.toBeNull();
        expect(verdict.match ?? "").toContain(fx.expected.matchContains);
      }
    });
  }
});
