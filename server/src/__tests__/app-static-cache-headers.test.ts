import { describe, expect, it } from "vitest";
import { staticCacheControlOverride } from "../app.js";

describe("staticCacheControlOverride", () => {
  it("marks the entry document and the service worker no-cache", () => {
    expect(staticCacheControlOverride("/srv/paperclip/ui-dist/index.html")).toBe("no-cache");
    expect(staticCacheControlOverride("/srv/paperclip/ui-dist/sw.js")).toBe("no-cache");
  });

  it("leaves other non-hashed static files on the default max-age", () => {
    expect(staticCacheControlOverride("/srv/paperclip/ui-dist/favicon.ico")).toBeNull();
    expect(staticCacheControlOverride("/srv/paperclip/ui-dist/site.webmanifest")).toBeNull();
    expect(staticCacheControlOverride("/srv/paperclip/ui-dist/robots.txt")).toBeNull();
  });

  it("leaves hashed assets alone", () => {
    expect(staticCacheControlOverride("/srv/paperclip/ui-dist/assets/main.a1b2c3d4.js")).toBeNull();
  });
});
