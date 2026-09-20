import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveBrowserBuildCommit } from "./vite-build-commit";

describe("browser build attribution", () => {
  it("accepts and normalizes the full source commit supplied by image CI", () => {
    expect(resolveBrowserBuildCommit(" 0123456789ABCDEF0123456789ABCDEF01234567\n"))
      .toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it.each([undefined, "", "main", "0123456", "https://example.invalid/private-build?token=canary"])(
    "omits an unknown or non-commit value: %s", (value) => {
      expect(resolveBrowserBuildCommit(value)).toBeNull();
    },
  );

  it("makes the Docker build commit available before building the browser", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL("../../../Dockerfile", import.meta.url)), "utf8");
    const stage = dockerfile.split("FROM runner-build AS build")[1]?.split("FROM base AS production")[0];
    expect(stage).toBeDefined();
    const arg = stage!.indexOf('ARG PAPERCLIP_BUILD_COMMIT=""');
    const browserBuild = stage!.indexOf("RUN pnpm --filter @paperclipai/ui build");
    expect(arg).toBeGreaterThanOrEqual(0);
    expect(browserBuild).toBeGreaterThan(arg);
  });
});
