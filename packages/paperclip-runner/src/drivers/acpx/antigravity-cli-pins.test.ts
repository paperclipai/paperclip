import { describe, expect, it } from "vitest";
import declaration from "../../../antigravity-cli-distributions.json" with { type: "json" };
import { ANTIGRAVITY_CLI_DISTRIBUTION } from "./antigravity-cli-pins.js";

describe("Antigravity CLI pins", () => {
  it("compile in exactly the checked-in declaration's launch identity", () => {
    expect(ANTIGRAVITY_CLI_DISTRIBUTION).toEqual({
      version: declaration.version,
      build: declaration.build,
      args: declaration.args,
      environment: declaration.environment,
      platforms: Object.fromEntries(Object.entries(declaration.platforms).map(([target, item]) => [target, {
        executable: item.executable, closureSha256: item.closureSha256, entries: item.entries,
      }])),
    });
  });
});
