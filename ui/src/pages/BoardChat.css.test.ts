import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PAP-54: the .typing-dots CSS block was silently dropped from index.css
 * during a theme migration, leaving static markup with no animation. Guard
 * the source so the block can't vanish again without failing a test. The
 * browser-computed `animationName !== "none"` assertion lives in
 * tests/e2e/conference-room-typing-intro.spec.ts.
 */
function readIndexCss(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    for (const candidate of [
      path.join(dir, "src/index.css"),
      path.join(dir, "ui/src/index.css"),
    ]) {
      if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    }
    dir = path.dirname(dir);
  }
  throw new Error("ui/src/index.css not found from " + process.cwd());
}

describe("typing-dots CSS animation guard (PAP-54 failure mode)", () => {
  const css = readIndexCss();

  it("keeps the bounce animation wired to .typing-dots span", () => {
    const spanRules = [...css.matchAll(/\.typing-dots span\s*\{[^}]*\}/g)].map(
      (match) => match[0],
    );
    expect(spanRules.length).toBeGreaterThan(0);
    expect(
      spanRules.some((rule) => /animation:\s*typing-bounce/.test(rule)),
    ).toBe(true);
  });

  it("keeps the typing-bounce keyframes", () => {
    expect(css).toMatch(/@keyframes typing-bounce\s*\{/);
  });
});
