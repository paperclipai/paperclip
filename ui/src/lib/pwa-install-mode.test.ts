import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("PWA install mode", () => {
  it("requests a chromeless window so the in-app browser controls apply", () => {
    const manifest = JSON.parse(readFileSync(resolve(uiRoot, "public/site.webmanifest"), "utf8")) as {
      display?: string;
    };
    const html = readFileSync(resolve(uiRoot, "index.html"), "utf8");

    // `browser` makes the app uninstallable: Chrome reports
    // `manifest-display-not-supported` and only offers a shortcut. `standalone`
    // is the installable mode, and it is the mode the app is already written for
    // — StandaloneBrowserControls renders Refresh / Share / Open in Browser only
    // when the launch is chromeless, which nothing could trigger before this.
    expect(manifest.display).toBe("standalone");
    // The legacy `mobile-web-app-capable` meta is unnecessary (Chrome reads the
    // manifest) and the Apple metas stay out: iOS is not an install target for
    // this change, because Safari needs those metas rather than the manifest.
    expect(html).not.toContain('name="mobile-web-app-capable"');
    expect(html).not.toContain('name="apple-mobile-web-app-capable"');
    expect(html).not.toContain('name="apple-mobile-web-app-status-bar-style"');
  });

  it("fetches the manifest with credentials so authenticating proxies can serve it", () => {
    const html = readFileSync(resolve(uiRoot, "index.html"), "utf8");

    // Browsers fetch <link rel="manifest"> in "omit credentials" mode unless
    // the link opts in. Behind an authenticating reverse proxy (e.g. a
    // managed-hosting front door), the cookie-less request is rejected on
    // every page load.
    expect(html).toContain('rel="manifest" href="/site.webmanifest" crossorigin="use-credentials"');
  });
});
