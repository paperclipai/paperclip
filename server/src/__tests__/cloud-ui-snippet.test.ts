import { describe, expect, it } from "vitest";
import { injectCloudUiSnippet } from "../cloud-ui-snippet.js";

const html = '<html><body><div id="root"></div></body></html>';
const snippet = '<script src="https://example.com/widget.js"></script>';
const encoded = Buffer.from(snippet, "utf-8").toString("base64");

describe("Cloud UI snippet", () => {
  it("leaves self-hosted HTML unchanged even when a snippet is configured", () => {
    expect(injectCloudUiSnippet(html, { PAPERCLIP_CLOUD_UI_SNIPPET: snippet })).toBe(html);
    expect(injectCloudUiSnippet(html, { PAPERCLIP_CLOUD_UI_SNIPPET_B64: encoded })).toBe(html);
  });

  it.each([
    { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "test-token" },
    { PAPERCLIP_MANAGED_CONFIG: "{}" },
  ])("injects only on a configured Cloud instance: %j", (cloud) => {
    expect(injectCloudUiSnippet(html, { ...cloud, PAPERCLIP_CLOUD_UI_SNIPPET: snippet }))
      .toBe(html.replace("</body>", `${snippet}\n</body>`));
    expect(injectCloudUiSnippet(html, cloud)).toBe(html);
    expect(injectCloudUiSnippet(html, { ...cloud, PAPERCLIP_CLOUD_UI_SNIPPET: "  " })).toBe(html);
  });

  it("preserves literal replacement tokens in operator JavaScript", () => {
    const script = '<script>console.log("$&", "$`", "$\'");</script>';
    const result = injectCloudUiSnippet(html, {
      PAPERCLIP_MANAGED_CONFIG: "{}", PAPERCLIP_CLOUD_UI_SNIPPET: script,
    });
    expect(result).toContain(script);
    expect(result).not.toContain("test-token");
  });

  it("decodes a base64 snippet on a Cloud instance", () => {
    expect(injectCloudUiSnippet(html, {
      PAPERCLIP_MANAGED_CONFIG: "{}", PAPERCLIP_CLOUD_UI_SNIPPET_B64: encoded,
    })).toBe(html.replace("</body>", `${snippet}\n</body>`));
  });

  it("tolerates whitespace and line wrapping in the base64 value", () => {
    const wrapped = `  ${encoded.slice(0, 20)}\n${encoded.slice(20)}\n`;
    expect(injectCloudUiSnippet(html, {
      PAPERCLIP_MANAGED_CONFIG: "{}", PAPERCLIP_CLOUD_UI_SNIPPET_B64: wrapped,
    })).toBe(html.replace("</body>", `${snippet}\n</body>`));
  });

  it("prefers the plain snippet when both variables are set", () => {
    const other = Buffer.from("<script>other()</script>", "utf-8").toString("base64");
    const result = injectCloudUiSnippet(html, {
      PAPERCLIP_MANAGED_CONFIG: "{}",
      PAPERCLIP_CLOUD_UI_SNIPPET: snippet,
      PAPERCLIP_CLOUD_UI_SNIPPET_B64: other,
    });
    expect(result).toContain(snippet);
    expect(result).not.toContain("other()");
  });

  it("treats a blank plain variable as disabled even when a base64 value is set", () => {
    expect(injectCloudUiSnippet(html, {
      PAPERCLIP_MANAGED_CONFIG: "{}",
      PAPERCLIP_CLOUD_UI_SNIPPET: "  ",
      PAPERCLIP_CLOUD_UI_SNIPPET_B64: encoded,
    })).toBe(html);
    expect(injectCloudUiSnippet(html, {
      PAPERCLIP_MANAGED_CONFIG: "{}",
      PAPERCLIP_CLOUD_UI_SNIPPET: "",
      PAPERCLIP_CLOUD_UI_SNIPPET_B64: encoded,
    })).toBe(html);
  });

  it.each([
    { label: "invalid characters", value: "!!!not-base64!!!" },
    { label: "wrong length", value: "abcde" },
    { label: "unpadded", value: Buffer.from("<b>x</b>", "utf-8").toString("base64").replace(/=+$/, "") },
    { label: "carrying nonzero padding bits", value: "PB==" },
    { label: "not valid UTF-8 once decoded", value: "/w==" },
    { label: "blank once decoded", value: Buffer.from("  \n ", "utf-8").toString("base64") },
    { label: "blank", value: "   " },
  ])("ignores a base64 value that is $label", ({ value }) => {
    expect(injectCloudUiSnippet(html, {
      PAPERCLIP_MANAGED_CONFIG: "{}", PAPERCLIP_CLOUD_UI_SNIPPET_B64: value,
    })).toBe(html);
  });
});
