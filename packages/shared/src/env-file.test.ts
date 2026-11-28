import { describe, expect, it } from "vitest";
import { encodeEnvValue, updateEnvFileContents } from "./env-file.js";

describe("env file editor", () => {
  it.each(["'", '"', "`"])("preserves the next assignment after a trailing backslash in a %s value", (quote) => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      const original = `PAPERCLIP_HOME=${quote}C:\\old\\${quote} # keep${newline}OTHER=${quote}keep${quote}${newline}`;
      expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "/new-home" }, { valueEncoding: "minimal" }))
        .toBe(`PAPERCLIP_HOME=/new-home # keep${newline}OTHER=${quote}keep${quote}${newline}`);
    }
  });

  it.each(["'", '"', "`"])("preserves comments after an unquoted path containing %s", (quote) => {
    const original = `PAPERCLIP_HOME=/old${quote}dir # keep this comment\n`;
    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "/new-home" }, { valueEncoding: "minimal" }))
      .toBe("PAPERCLIP_HOME=/new-home # keep this comment\n");
  });

  it.each(["'", '"', "`"])("preserves unrelated multiline %s values when adding a managed key", (quote) => {
    const original = `OPERATOR_NOTES=${quote}first line\nPAPERCLIP_HOME=/example\nlast line${quote}\n`;

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "/new-home" }, { valueEncoding: "minimal" }))
      .toBe(`${original}PAPERCLIP_HOME=/new-home\n`);
  });

  it.each(["\n", "\r\n", "\r"])("preserves multiline bytes with %j line endings", (newline) => {
    const original = [
      "export operator.notes = 'first line",
      "PAPERCLIP_HOME=/example",
      "",
      "last line' # keep this comment",
      "PAPERCLIP_HOME=/old-home",
    ].join(newline);

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "/new-home" }, { valueEncoding: "minimal" }))
      .toBe(original.replace("PAPERCLIP_HOME=/old-home", "PAPERCLIP_HOME=/new-home"));
  });

  it.each(["'", '"', "`"])("replaces an entire managed multiline %s value", (quote) => {
    const original = `PAPERCLIP_HOME=${quote}first line\n# value text\nlast line${quote} # retain\nOTHER=keep\n`;

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "/new-home" }, { valueEncoding: "minimal" }))
      .toBe("PAPERCLIP_HOME=/new-home # retain\nOTHER=keep\n");
  });

  it.each(["'", '"', "`"])("keeps an already current multiline %s assignment unchanged", (quote) => {
    const original = `PAPERCLIP_NOTE=${quote}first\nlast${quote} # keep\n`;

    expect(updateEnvFileContents(original, { PAPERCLIP_NOTE: "first\nlast" })).toBe(original);
  });

  it.each(["'", '"', "`"])("does not end a multiline %s value at an escaped quote", (quote) => {
    const original = `NOTES=${quote}first\\${quote}\nPAPERCLIP_HOME=/example\nlast${quote}\n`;

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "/new-home" }, { valueEncoding: "minimal" }))
      .toBe(`${original}PAPERCLIP_HOME=/new-home\n`);
  });

  it("does not let quotes in comments or unquoted values hide assignments", () => {
    const original = "# NOTES='\nOTHER=plain'\nPAPERCLIP_HOME=old\n# '";

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "new" }, { valueEncoding: "minimal" }))
      .toBe(original.replace("PAPERCLIP_HOME=old", "PAPERCLIP_HOME=new"));
  });

  it.each(["NOTES=\n", "operator.notes: "])("recognizes quoted values after %j", (prefix) => {
    const original = `${prefix}'first\nPAPERCLIP_HOME=example\nlast'\n`;

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "new" }, { valueEncoding: "minimal" }))
      .toBe(`${original}PAPERCLIP_HOME=new\n`);
  });

  it.each(["\n", "\r\n", "\r"])("preserves a multiline value with no final %j newline when appending a setting", (newline) => {
    const original = ["NOTES=`first", "PAPERCLIP_HOME=example", "last`"].join(newline);

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "new" }, { valueEncoding: "minimal" }))
      .toBe(`${original}${newline}PAPERCLIP_HOME=new`);
  });

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
