import { describe, expect, it } from "vitest";
import { injectRuntimeFeaturesHtml, serializeRuntimeFeaturesForHtml } from "../runtime-features-html.js";

describe("runtime feature HTML bootstrap", () => {
  it("escapes JSON for an inert application/json script", () => {
    const serialized = serializeRuntimeFeaturesForHtml({
      schemaVersion: 1,
      hostFeatures: ["apps.access_profiles"],
    });
    expect(serialized).not.toContain("<");
    expect(serialized).toContain('"apps.access_profiles"');

    const html = injectRuntimeFeaturesHtml(
      "<html><head><!-- PAPERCLIP_RUNTIME_FEATURES --></head></html>",
      { schemaVersion: 1, hostFeatures: [] },
    );
    expect(html).toContain('<script id="paperclip-runtime-features" type="application/json">');
    expect(html).not.toContain("PAPERCLIP_RUNTIME_FEATURES");
  });
});
