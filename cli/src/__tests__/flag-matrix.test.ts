import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitFlagHintsFromArgv } from "../commands/client/common.js";

describe("emitFlagHintsFromArgv", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("is silent when no known-wrong flag is present", () => {
    emitFlagHintsFromArgv([
      "issue",
      "create",
      "--title",
      "hi",
      "--project-id",
      "proj-1",
    ]);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("hints when --project-name is used (CLI accepts --project-id only)", () => {
    emitFlagHintsFromArgv(["issue", "list", "--project-name", "gBETA"]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toMatch(/--project-name/);
    expect(output).toMatch(/--project-id/);
  });

  it("hints when --parent-issue-id is used (real flag is --parent-id)", () => {
    emitFlagHintsFromArgv([
      "issue",
      "create",
      "--title",
      "child",
      "--parent-issue-id",
      "abc",
    ]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toMatch(/--parent-issue-id is not a recognized option/);
    expect(output).toMatch(/--parent-id/);
  });

  it("hints when `issue update` is combined with -C/--company-id", () => {
    emitFlagHintsFromArgv([
      "issue",
      "update",
      "abc",
      "-C",
      "company-1",
      "--status",
      "in_progress",
    ]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toMatch(/`issue update` does NOT accept -C\/--company-id/);
  });

  it("hints when `issue comment` is combined with --content (real flag is --body)", () => {
    emitFlagHintsFromArgv([
      "issue",
      "comment",
      "abc",
      "--content",
      "hello",
    ]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toMatch(/--body <text>, not --content/);
  });

  it("does NOT hint on -C when the subcommand is `issue create`", () => {
    emitFlagHintsFromArgv([
      "issue",
      "create",
      "-C",
      "company-1",
      "--title",
      "ok",
    ]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    // The company-flag hint is scoped to `issue update` only.
    expect(output).not.toMatch(/does NOT accept -C/);
  });
});
