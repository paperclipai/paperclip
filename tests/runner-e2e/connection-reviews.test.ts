import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONNECTOR_SETUP_NEXT_STEP } from "./connection-reviews.js";

describe("connection review setup", () => {
  it("accepts the one-screen Check link step and the older Save and continue step", () => {
    expect(CONNECTOR_SETUP_NEXT_STEP.test("Check link")).toBe(true);
    expect(CONNECTOR_SETUP_NEXT_STEP.test("Save and continue")).toBe(true);
    expect(CONNECTOR_SETUP_NEXT_STEP.test("Continue")).toBe(false);
    expect(CONNECTOR_SETUP_NEXT_STEP.test("Checking…")).toBe(false);
  });

  it("matches a label the current connector setup actually renders", async () => {
    const source = await readFile(new URL("../../ui/src/features/connections/ConnectionSetupFlow.tsx", import.meta.url), "utf8");
    const labels = [...source.matchAll(/"(Check link|Save and continue)"/g)].map(match => match[1]!);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every(label => CONNECTOR_SETUP_NEXT_STEP.test(label))).toBe(true);
  });
});
