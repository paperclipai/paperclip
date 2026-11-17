import { describe, expect, it } from "vitest";
import { HTML_PREVIEW_CSP, htmlPreviewDocument, isHtmlPreview } from "./html-preview";
import { isTextAttachment } from "./issue-attachments";

describe("HTML artifact previews", () => {
  it("recognizes HTML MIME types and filenames including generic uploaded files", () => {
    for (const [type, name] of [["text/html; charset=utf-8", "report"], ["TEXT/HTML", "report"], ["application/xhtml+xml", "report"], ["application/octet-stream", "report.HTML"], ["text/plain", "report.htm"]]) {
      expect(isHtmlPreview(type, name)).toBe(true);
      expect(isTextAttachment({ contentType: type, originalFilename: name })).toBe(true);
    }
    expect(isHtmlPreview("text/plain", "notes.txt")).toBe(false);
    expect(isHtmlPreview("text/markdown", "report.md")).toBe(false);
  });
  it("puts the trusted policy before adversarial complete documents without parsing in the host DOM", () => {
    const html = '</head><meta http-equiv="Content-Security-Policy" content="default-src *"><script>parent.document.cookie</script>';
    const doc = htmlPreviewDocument(html);
    expect(doc.indexOf(`content="${HTML_PREVIEW_CSP}"`)).toBeLessThan(doc.indexOf(html));
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain("form-action 'none'");
    expect(doc).toContain("base-uri 'none'");
    expect(doc).toContain("frame-src 'none'");
    expect(doc).not.toContain("script-src 'self'");
    expect(doc).not.toContain("unsafe-eval");
  });
});
