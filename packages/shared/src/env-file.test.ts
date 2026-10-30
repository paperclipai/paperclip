import { describe, expect, it } from "vitest";
import { encodeEnvValue, updateEnvFileContents } from "./env-file.js";

describe("env file editor", () => {
  it("pins minimal and JSON value encoding", () => {
    expect(encodeEnvValue("plain-value", "minimal")).toBe("plain-value");
    expect(encodeEnvValue("#439edb", "minimal")).toBe('"#439edb"');
    expect(encodeEnvValue("plain-value", "json")).toBe('"plain-value"');
  });

  it("preserves unrelated content and CRLF while updating every stale duplicate", () => {
    const original = [
      "# operator comment",
      "UNKNOWN='keep this encoding'",
      "",
      "export PAPERCLIP_HOME = '/old path'  # managed path",
      "PAPERCLIP_DUPLICATE=stale",
      'PAPERCLIP_DUPLICATE="current"',
      "TRAILING=untouched",
      "",
    ].join("\r\n");

    const updated = updateEnvFileContents(
      original,
      {
        PAPERCLIP_HOME: "/new path",
        PAPERCLIP_DUPLICATE: "current",
        PAPERCLIP_WORKTREE_COLOR: "#439edb",
      },
      { valueEncoding: "minimal" },
    );

    expect(updated).toBe([
      "# operator comment",
      "UNKNOWN='keep this encoding'",
      "",
      'export PAPERCLIP_HOME = "/new path"  # managed path',
      "PAPERCLIP_DUPLICATE=current",
      'PAPERCLIP_DUPLICATE="current"',
      "TRAILING=untouched",
      'PAPERCLIP_WORKTREE_COLOR="#439edb"',
      "",
    ].join("\r\n"));
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("uses JSON encoding for changed values without re-encoding current assignments", () => {
    const original = [
      "PAPERCLIP_CURRENT=plain-value",
      "PAPERCLIP_CHANGED=old",
      "UNKNOWN=\"operator value\"",
      "",
    ].join("\n");

    expect(
      updateEnvFileContents(
        original,
        {
          PAPERCLIP_CURRENT: "plain-value",
          PAPERCLIP_CHANGED: "new",
          PAPERCLIP_ADDED: "added",
        },
        { valueEncoding: "json" },
      ),
    ).toBe([
      "PAPERCLIP_CURRENT=plain-value",
      'PAPERCLIP_CHANGED="new"',
      'UNKNOWN="operator value"',
      'PAPERCLIP_ADDED="added"',
      "",
    ].join("\n"));
  });

  it("does not treat an unquoted dotenv comment as the managed value", () => {
    expect(
      updateEnvFileContents(
        ["PAPERCLIP_COLOR=#439edb", "PAPERCLIP_HOME=old# keep this comment"].join("\n"),
        {
          PAPERCLIP_COLOR: "#439edb",
          PAPERCLIP_HOME: "new",
        },
        { valueEncoding: "minimal" },
      ),
    ).toBe(
      ['PAPERCLIP_COLOR="#439edb"#439edb', "PAPERCLIP_HOME=new# keep this comment"].join("\n"),
    );
  });

  it("is a no-op when every managed duplicate is already current", () => {
    const original = [
      "export PAPERCLIP_HOME = '/same path' # first",
      'PAPERCLIP_HOME="/same path"',
      "UNKNOWN=value",
    ].join("\n");

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "/same path" })).toBe(original);
  });
});
