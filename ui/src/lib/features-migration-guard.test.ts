import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Admin-only surfaces that legitimately keep the admin instance-settings API.
const ALLOWLIST = new Set([
  join(SRC_ROOT, "api", "instanceSettings.ts"),
  join(SRC_ROOT, "pages", "InstanceExperimentalSettings.tsx"),
  join(SRC_ROOT, "pages", "InstanceGeneralSettings.tsx"),
  join(SRC_ROOT, "pages", "InstanceAccess.tsx"),
  join(SRC_ROOT, "components", "access", "CompanySurfaceVisibilityCard.tsx"),
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("capabilities.features migration guard", () => {
  it("no non-admin source file reads /instance/settings directly", () => {
    const offenders = walk(SRC_ROOT).filter((file) => {
      if (ALLOWLIST.has(file)) return false;
      const text = readFileSync(file, "utf8");
      return /instanceSettingsApi\.(get|getGeneral|getExperimental)\(/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
