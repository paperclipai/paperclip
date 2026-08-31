import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as generatedTelemetry from "./generated/paperclip-telemetry.js";

const readmePath = fileURLToPath(new URL("./README.md", import.meta.url));

describe("telemetry README contract", () => {
  it("documents generated event helper exports that exist", () => {
    const readme = readFileSync(readmePath, "utf8");

    expect(generatedTelemetry.SCHEMA_VERSION).toBeDefined();
    expect(generatedTelemetry.makeEvent).toBeTypeOf("function");
    expect(generatedTelemetry.makeBatch).toBeTypeOf("function");
    expect(readme).toContain("`SCHEMA_VERSION`, `makeEvent()`, and `makeBatch()`");
    expect(readme).not.toContain("createPaperclipTelemetryEvent");
    expect(readme).not.toContain("createPaperclipTelemetryEnvelope");
  });
});
