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
    const en = JSON.parse(await readFile(new URL("../../ui/src/i18n/locales/en.json", import.meta.url), "utf8"));
    const keys = [...source.matchAll(/t\("([\w.]+)"\)/g)].map(match => match[1]!);
    const labels = keys
      .map(key => key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en))
      .filter((value): value is string => value === "Check link" || value === "Save and continue");
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every(label => CONNECTOR_SETUP_NEXT_STEP.test(label))).toBe(true);
  });
});
