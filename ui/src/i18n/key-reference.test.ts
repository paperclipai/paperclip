import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import en from "./locales/en.json";

/**
 * Every static t("namespace.key") reference in the UI must resolve to a key
 * that exists in en.json. This is the regression net for localization work:
 * a component that references a missing key renders the raw key string
 * instead of text, which is easy to miss in code review.
 *
 * Dynamic references (template literals, concatenation, key suffixes like
 * t(`adapterConfig.${x}`)) are intentionally not matched.
 */

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".vite") continue;
      out.push(...collectTsxFiles(full));
    } else if (
      (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) &&
      !entry.name.endsWith(".test.tsx") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.tsx") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

const srcDir = path.resolve(__dirname, "..");
const files = collectTsxFiles(srcDir);

const staticKeyRe = /(?<![A-Za-z0-9_.])t\(\s*"([A-Za-z0-9_.-]+)"\s*(?:,|\))/g;
const transKeyRe = /i18nKey="([A-Za-z0-9_.-]+)"/g;

function getByPath(obj: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

describe("i18n key references", () => {
  it("every static t() and Trans key in the UI exists in en.json", () => {
    const missing: Array<{ file: string; key: string }> = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const refs: string[] = [];
      for (const m of source.matchAll(staticKeyRe)) refs.push(m[1]);
      for (const m of source.matchAll(transKeyRe)) refs.push(m[1]);
      for (const key of new Set(refs)) {
        if (getByPath(en, key) === undefined) missing.push({ file: path.relative(srcDir, file), key });
      }
    }
    expect(missing).toEqual([]);
  });
});
