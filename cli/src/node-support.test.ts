import { describe, expect, it } from "vitest";
import {
  buildUnsupportedNodeMessage,
  formatNodeCommandContext,
  isSupportedNodeVersion,
  readExpectedNodeRangeForModule,
} from "@paperclipai/shared/node-support";

describe("node support helpers", () => {
  it("reads the nearest package engines range", () => {
    expect(readExpectedNodeRangeForModule(import.meta.url)).toBe(">=20.19.0 <21 || >=24.0.0");
  });

  it("treats odd-numbered unsupported runtimes as failures", () => {
    expect(
      isSupportedNodeVersion({
        expectedRange: ">=20.19.0 <21 || >=24.0.0",
        currentVersion: "v21.5.0",
      }),
    ).toBe(false);
  });

  it("formats command context consistently", () => {
    expect(formatNodeCommandContext("paperclipai")).toBe("`pnpm paperclipai`");
    expect(formatNodeCommandContext("pnpm exec tsx cli/src/index.ts")).toBe(
      "`pnpm exec tsx cli/src/index.ts`",
    );
  });

  it("builds the unsupported runtime guidance text", () => {
    expect(
      buildUnsupportedNodeMessage({
        expectedRange: ">=20.19.0 <21 || >=24.0.0",
        currentVersion: "v21.5.0",
        commandContext: "paperclipai",
      }),
    ).toContain("Unsupported Node.js runtime");
  });
});
