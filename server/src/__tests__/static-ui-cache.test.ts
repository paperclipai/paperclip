import path from "node:path";
import { describe, expect, it } from "vitest";
import { staticUiCacheControl } from "../static-ui-cache.js";

describe("staticUiCacheControl", () => {
  it("forces revalidation for index.html", () => {
    expect(staticUiCacheControl(path.join("/srv", "ui-dist", "index.html"))).toBe("no-cache");
  });

  it("forces revalidation for the service-worker script", () => {
    // Browsers refresh an installed worker only by re-fetching /sw.js; a
    // cached copy pins every client on old worker code for the TTL.
    expect(staticUiCacheControl(path.join("/srv", "ui-dist", "sw.js"))).toBe("no-cache");
  });

  it("leaves other static files on the middleware default", () => {
    expect(staticUiCacheControl(path.join("/srv", "ui-dist", "favicon.ico"))).toBeUndefined();
    expect(staticUiCacheControl(path.join("/srv", "ui-dist", "robots.txt"))).toBeUndefined();
    // Lookalikes keep the default: only the exact worker filename is special.
    expect(staticUiCacheControl(path.join("/srv", "ui-dist", "sw.js.map"))).toBeUndefined();
  });
});
