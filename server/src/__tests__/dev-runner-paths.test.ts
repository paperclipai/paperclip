import { describe, expect, it } from "vitest";
import { shouldTrackDevServerPath } from "../../../scripts/dev-runner-paths.mjs";

describe("shouldTrackDevServerPath", () => {
  it("ignores repo-local Paperclip state and common test file paths", () => {
    expect(
      shouldTrackDevServerPath(
        ".paperclip/worktrees/PAP-712-for-project-configuration-get-rid-of-the-overview-tab-for-now/.agents/skills/paperclip",
      ),
    ).toBe(false);
    expect(shouldTrackDevServerPath("server/src/__tests__/health.test.ts")).toBe(false);
    expect(shouldTrackDevServerPath("packages/shared/src/lib/foo.test.ts")).toBe(false);
    expect(shouldTrackDevServerPath("packages/shared/src/lib/foo.spec.tsx")).toBe(false);
    expect(shouldTrackDevServerPath("packages/shared/_tests/helpers.ts")).toBe(false);
    expect(shouldTrackDevServerPath("packages/shared/tests/helpers.ts")).toBe(false);
    expect(shouldTrackDevServerPath("packages/shared/test/helpers.ts")).toBe(false);
    expect(shouldTrackDevServerPath("vitest.config.ts")).toBe(false);
  });

  it("keeps runtime paths restart-relevant", () => {
    expect(shouldTrackDevServerPath("server/src/routes/health.ts")).toBe(true);
    expect(shouldTrackDevServerPath("packages/shared/src/index.ts")).toBe(true);
    expect(shouldTrackDevServerPath("server/src/testing/runtime.ts")).toBe(true);
  });
});
