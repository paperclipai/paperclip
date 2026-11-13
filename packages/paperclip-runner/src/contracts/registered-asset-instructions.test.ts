import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { composeNativeSystemInstructions, type NativeRuntimeContextSnapshot } from "./runtime-context.js";

it("keeps the TypeScript instruction composer and Rust attachment fixture in sync", () => {
  const fixtures = JSON.parse(readFileSync(new URL("../../test/fixtures/registered-asset-instructions.json", import.meta.url), "utf8")) as Array<{context: NativeRuntimeContextSnapshot; entry: string; instructions: string}>;
  for (const fixture of fixtures) expect(composeNativeSystemInstructions(fixture.context, fixture.entry)).toBe(fixture.instructions);
});
