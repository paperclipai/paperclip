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

  it("hints when --project-title is used (symmetric with --project-name)", () => {
    emitFlagHintsFromArgv(["issue", "list", "--project-title", "gBETA"]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toMatch(/--project-title/);
    expect(output).toMatch(/--project-id/);
  });

  it("does NOT false-positive when a --title VALUE contains 'issue update -C'", () => {
    // Regression: the previous `argv.join(' ')` sweep would misfire here.
    emitFlagHintsFromArgv([
      "issue",
      "create",
      "--title",
      "Fix issue update -C handling",
      "-C",
      "company-1",
    ]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    // `issue create` + explicit -C is valid; the update-only hint must NOT fire.
    expect(output).not.toMatch(/`issue update` does NOT accept/);
  });

  it("does NOT false-positive when a --title VALUE mentions --project-name", () => {
    emitFlagHintsFromArgv([
      "issue",
      "create",
      "--title",
      "use --project-name or --project-id",
      "--description",
      "note",
    ]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).not.toMatch(/--project-name \/ --project-title are not supported/);
  });

  it("does NOT false-positive when a --description VALUE mentions --parent-issue-id", () => {
    emitFlagHintsFromArgv([
      "issue",
      "create",
      "--title",
      "t",
      "--description",
      "note about --parent-issue-id naming history",
    ]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).not.toMatch(/--parent-issue-id is not a recognized option/);
  });

  it("does NOT false-positive when a --body VALUE mentions --content", () => {
    emitFlagHintsFromArgv([
      "issue",
      "comment",
      "abc-uuid",
      "--body",
      "deprecated name was --content",
    ]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).not.toMatch(/`issue comment` uses --body <text>, not --content/);
  });

  it("supports --flag=value syntax for project hints", () => {
    emitFlagHintsFromArgv(["issue", "list", "--project-name=gBETA"]);
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toMatch(/--project-name/);
    expect(output).toMatch(/--project-id/);
  });
});
