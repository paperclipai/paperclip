import assert from "node:assert/strict";
import test from "node:test";

import { prepareNpmReadme } from "./prepare-npm-readme.mjs";

const assetBase =
  "https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/assets/";

test("rewrites repository-relative image sources for npm", () => {
  const readme = [
    '<img src="doc/assets/banner.jpg">',
    '<source srcset="doc/assets/light.png, doc/assets/dark.png">',
    '[docs](doc/assets/not-an-image.md)',
    '<img src="https://example.com/already-absolute.png">',
    '<img src="https://example.com/doc/assets/already-absolute.png">',
  ].join("\n");

  assert.equal(
    prepareNpmReadme(readme),
    [
      `<img src="${assetBase}banner.jpg">`,
      `<source srcset="${assetBase}light.png, ${assetBase}dark.png">`,
      "[docs](doc/assets/not-an-image.md)",
      '<img src="https://example.com/already-absolute.png">',
      '<img src="https://example.com/doc/assets/already-absolute.png">',
    ].join("\n"),
  );
});
