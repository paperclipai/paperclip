import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("../index.css", import.meta.url), "utf8");

describe("global focus styles", () => {
  it("leaves the outline color unset so native auto outlines keep their contrast-safe rendering", () => {
    const universalBaseRule = stylesheet.match(/@layer base\s*{\s*\*\s*{(?<body>[^}]*)}/)?.groups?.body;

    expect(universalBaseRule).toBeDefined();
    expect(universalBaseRule).not.toMatch(/outline-(?:ring|color)|outline-color/);
  });
});
