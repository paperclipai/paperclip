import { describe, expect, it } from "vitest";
import { createUiDevWatchOptions, shouldIgnoreUiDevWatchPath } from "./vite-watch";

describe("shouldIgnoreUiDevWatchPath", () => {
  it("ignores test-only files and folders", () => {
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/src/components/IssuesList.test.tsx")).toBe(true);
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/src/lib/issue-tree.spec.ts")).toBe(true);
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/src/__tests__/helpers.ts")).toBe(true);
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/tests/helpers.ts")).toBe(true);
  });

  it("keeps runtime source files watchable", () => {
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/src/components/IssuesList.tsx")).toBe(false);
    expect(shouldIgnoreUiDevWatchPath("/repo/ui/src/pages/IssueDetail.tsx")).toBe(false);
  });
});

describe("createUiDevWatchOptions", () => {
  it("preserves the WSL /mnt polling fallback", () => {
    expect(createUiDevWatchOptions("/mnt/c/paperclip")).toMatchObject({
      usePolling: true,
      interval: 1000,
    });
  });

  it("always includes the ignored-path predicate", () => {
    expect(createUiDevWatchOptions("/Users/dotta/paperclip")).toHaveProperty("ignored");
  });
});
