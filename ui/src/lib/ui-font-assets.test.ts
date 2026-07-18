import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fontDir = path.join(uiRoot, "public", "fonts");
const cssPath = path.join(uiRoot, "src", "index.css");

const fontFiles = ["InterVariable.woff2", "InterVariable-Italic.woff2"];

describe("bundled UI font assets", () => {
  it("ships the Inter variable font files used by the CSS", () => {
    const css = readFileSync(cssPath, "utf8");

    for (const fileName of fontFiles) {
      const fontPath = path.join(fontDir, fileName);
      expect(existsSync(fontPath), `${fileName} should exist in ui/public/fonts`).toBe(true);
      expect(statSync(fontPath).isFile(), `${fileName} should be a file`).toBe(true);
      expect(readFileSync(fontPath).subarray(0, 4).toString("ascii")).toBe("wOF2");
      expect(css).toContain(`url("../fonts/${fileName}")`);
    }

    expect(css).toContain('--font-sans: "InterVariable"');
  });

  it("includes redistribution notice text for the bundled Inter files", () => {
    const notice = readFileSync(path.join(fontDir, "NOTICE.md"), "utf8");

    expect(notice).toContain("Inter");
    expect(notice).toContain("v4.1");
    expect(notice).toContain("SIL Open Font License 1.1");
    expect(notice).toContain("InterVariable.woff2");
    expect(notice).toContain("InterVariable-Italic.woff2");
  });
});
