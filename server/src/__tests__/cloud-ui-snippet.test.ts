import { describe, expect, it } from "vitest";
import { injectCloudUiSnippet } from "../cloud-ui-snippet.js";

const html = '<html><body><div id="root"></div></body></html>';
const snippet = '<script src="https://example.com/widget.js"></script>';

describe("Cloud UI snippet", () => {
  it("leaves self-hosted HTML unchanged even when a snippet is configured", () => {
    expect(injectCloudUiSnippet(html, { PAPERCLIP_CLOUD_UI_SNIPPET: snippet })).toBe(html);
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
});
