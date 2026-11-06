import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PatchLines } from "./PatchLines";
import { isPatchFile } from "@/lib/patch";

describe("patch source", () => {
  it.each(["fix.patch", "FIX.DIFF"])("recognizes %s and patch MIME types", (filename) => {
    expect(isPatchFile(filename)).toBe(true);
    expect(isPatchFile("download", "Text/X-Patch; charset=utf-8")).toBe(true);
    expect(isPatchFile(null, "text/x-diff")).toBe(true);
    expect(isPatchFile("notes.txt", "text/plain")).toBe(false);
  });

  it("preserves CRLF source and header-like changes across multiple files, and escapes HTML", () => {
    const source = "diff --git a/a b/a\r\n--- a/a\r\n+++ b/a\r\n@@ -1 +1 @@\r\n--- old\r\n+++ new\r\ndiff --git a/b b/b\r\n--- a/b\r\n+++ b/b\r\n@@ -1 +1 @@\r\n-<script>old</script>\r\n+new";
    const markup = renderToStaticMarkup(<code><PatchLines text={source} /></code>);
    expect(markup.match(/data-patch-line="add"/g)).toHaveLength(2);
    expect(markup.match(/data-patch-line="remove"/g)).toHaveLength(2);
    expect(markup.match(/data-patch-line="skip"/g)).toHaveLength(6);
    expect(markup).not.toContain("<script>");
    expect(markup.replace(/<[^>]*>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">")).toBe(source);
  });

  it("renders all lines in a large patch", () => {
    const source = "@@ -1 +1,2000 @@\n-old\n" + "+new\n".repeat(2000);
    const markup = renderToStaticMarkup(<PatchLines text={source} />);
    expect(markup.match(/data-patch-line="add"/g)).toHaveLength(2000);
  });
});
