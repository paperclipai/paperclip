import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(import.meta.dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const css = read("interaction-motion.css");
const guard = css.indexOf("@media (prefers-reduced-motion: no-preference)");

describe("interaction motion", () => {
  it("is part of the app's styles", () => {
    expect(read("index.css")).toContain('@import "./interaction-motion.css";');
  });

  it.each([
    ["--motion-popup-enter", "400ms"], ["--motion-popup-exit", "160ms"],
    ["--motion-menu-enter", "260ms"], ["--motion-menu-exit", "120ms"],
    ["--motion-sheet-enter", "420ms"], ["--motion-sheet-exit", "210ms"],
    ["--motion-page-enter", "300ms"], ["--motion-row-enter", "340ms"], ["--motion-row-stagger", "55ms"],
    ["--motion-press-in", "90ms"], ["--motion-press-out", "210ms"],
    ["--motion-finish-check", "480ms"],
  ])("keeps the approved timing for %s", (name, value) => {
    expect(css).toContain(`${name}: ${value};`);
  });

  it.each(["dialog-content", "alert-dialog-content", "sheet-content", "popover-content", "dropdown-menu-content", "dropdown-menu-sub-content", "select-content", "button"])(
    "covers %s", (slot) => {
      expect(css.slice(guard)).toContain(`[data-slot="${slot}"]`);
    });

  it.each(['[data-slot="task-row-group"]', "[data-issue-row-id]", '[data-slot="entity-row"]'])("staggers %s rows", (row) => {
    expect(css.slice(guard)).toContain(row);
  });

  it("only moves things for people who have not asked for reduced motion", () => {
    expect(guard).toBeGreaterThan(-1);
    expect(css.slice(0, guard)).not.toMatch(/[\s;{](animation|scale):/);
  });
});
