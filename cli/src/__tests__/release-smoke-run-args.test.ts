import { describe, expect, it } from "vitest";
import { normalizeReleaseSmokeArgs } from "../../../scripts/release-smoke-run-args.mjs";

describe("release smoke arg normalization", () => {
  it("strips one or more leading double-dash separators", () => {
    expect(normalizeReleaseSmokeArgs(["--", "--list"])).toEqual(["--list"]);
    expect(normalizeReleaseSmokeArgs(["--", "--", "--list"])).toEqual(["--list"]);
  });

  it("preserves non-separator arguments", () => {
    expect(normalizeReleaseSmokeArgs(["--list", "--project", "chromium"]))
      .toEqual(["--list", "--project", "chromium"]);
  });
});
