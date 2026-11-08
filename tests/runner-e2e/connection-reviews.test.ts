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

  it.each(["LinkConnectStep", "ZapierConnectStep"])("matches the label %s actually renders", async (component) => {
    const source = await readFile(new URL("../../ui/src/features/connections/ConnectionSetupFlow.tsx", import.meta.url), "utf8");
    const catalog: Record<string, string> = JSON.parse(await readFile(
      new URL("../../ui/src/i18n/catalogs/en/connections.json", import.meta.url), "utf8",
    ));
    const step = source.match(new RegExp(`function ${component}\\b[\\s\\S]*?(?=\\nfunction |$)`))?.[0];
    expect(step).toBeDefined();
    expect(step).toContain('useTranslation("connections")');
    // Resolve the idle label from the actual connect button, not an unrelated
    // translation call or a catalog entry that the setup no longer uses.
    const button = step!.match(/<Button\s+onClick=\{onConnect\}[^>]*>([\s\S]*?)<\/Button>/)?.[1];
    expect(button).toBeDefined();
    const key = button!.match(/submitting\s*\?\s*t\("[^"]+"\)\s*:\s*t\("([^"]+)"\)/)?.[1];
    expect(key).toBeDefined();
    expect(Object.hasOwn(catalog, key!)).toBe(true);
    expect(typeof catalog[key!]).toBe("string");
    expect(CONNECTOR_SETUP_NEXT_STEP.test(catalog[key!]!)).toBe(true);
  });
});
