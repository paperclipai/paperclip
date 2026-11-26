import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { prepareNpmReadme } from "./prepare-npm-readme.mjs";

const assetBase =
  "https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/assets/";
const releaseAssetBase =
  "https://raw.githubusercontent.com/paperclipai/paperclip/abc123/doc/assets/";

test("rewrites repository-relative image sources for npm", () => {
  const readme = [
    '<img src="doc/assets/banner.jpg">',
    '<source srcset="doc/assets/light.png, doc/assets/dark.png">',
    '[docs](doc/assets/not-an-image.md)',
    '<img src="https://example.com/already-absolute.png">',
    '<img src="https://example.com/doc/assets/already-absolute.png">',
  ].join("\n");

  assert.equal(
    prepareNpmReadme(readme, "master"),
    [
      `<img src="${assetBase}banner.jpg">`,
      `<source srcset="${assetBase}light.png, ${assetBase}dark.png">`,
      "[docs](doc/assets/not-an-image.md)",
      '<img src="https://example.com/already-absolute.png">',
      '<img src="https://example.com/doc/assets/already-absolute.png">',
    ].join("\n"),
  );
});

test("prepares the repository README without package-relative image sources", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const npmReadme = prepareNpmReadme(readme, "master");

  assert.doesNotMatch(
    npmReadme,
    /(?:src|srcset)=["'](?:doc\/assets\/|[^"']*,\s*doc\/assets\/)/,
  );
});

test("supports immutable release refs for generated asset URLs", () => {
  assert.equal(
    prepareNpmReadme('<img src="doc/assets/banner.jpg">', "abc123"),
    `<img src="${releaseAssetBase}banner.jpg">`,
  );
});
