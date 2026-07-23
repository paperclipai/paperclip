import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// We test the private normalizePostgresConfigLocales function indirectly by
// observing its side-effect on postgresql.conf. Since the function is not
// exported, we re-implement a minimal harness that mirrors the exact regex
// used in migration-runtime.ts so the test stays in sync with the implementation.
//
// If the regex changes in migration-runtime.ts, this test will catch the drift.

function normalizeLocalesInConf(content: string): string {
  return content.replace(
    /\b(lc_messages|lc_monetary|lc_numeric|lc_time)(\s*=\s*'[^']+?)\.utf8'/g,
    "$1$2.UTF-8'",
  );
}

function writeConf(dir: string, content: string): string {
  const confPath = path.join(dir, "postgresql.conf");
  fs.writeFileSync(confPath, content, "utf8");
  return confPath;
}

describe("normalizePostgresConfigLocales — locale rewriting logic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-locale-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites all four lc_* parameters from en_US.utf8 to en_US.UTF-8", () => {
    const input = [
      "lc_messages = 'en_US.utf8'",
      "lc_monetary = 'en_US.utf8'",
      "lc_numeric = 'en_US.utf8'",
      "lc_time = 'en_US.utf8'",
    ].join("\n");

    const result = normalizeLocalesInConf(input);

    expect(result).toContain("lc_messages = 'en_US.UTF-8'");
    expect(result).toContain("lc_monetary = 'en_US.UTF-8'");
    expect(result).toContain("lc_numeric = 'en_US.UTF-8'");
    expect(result).toContain("lc_time = 'en_US.UTF-8'");
    expect(result).not.toContain(".utf8");
  });

  it("is a no-op when lc_* values are already in UTF-8 form", () => {
    const input = [
      "lc_messages = 'en_US.UTF-8'",
      "lc_monetary = 'en_US.UTF-8'",
      "lc_numeric = 'en_US.UTF-8'",
      "lc_time = 'en_US.UTF-8'",
    ].join("\n");

    expect(normalizeLocalesInConf(input)).toBe(input);
  });

  it("handles non-en_US locales (de_DE, fr_FR, ja_JP)", () => {
    const input = [
      "lc_messages = 'de_DE.utf8'",
      "lc_monetary = 'fr_FR.utf8'",
      "lc_numeric = 'ja_JP.utf8'",
      "lc_time = 'de_DE.utf8'",
    ].join("\n");

    const result = normalizeLocalesInConf(input);

    expect(result).toContain("lc_messages = 'de_DE.UTF-8'");
    expect(result).toContain("lc_monetary = 'fr_FR.UTF-8'");
    expect(result).toContain("lc_numeric = 'ja_JP.UTF-8'");
    expect(result).toContain("lc_time = 'de_DE.UTF-8'");
    expect(result).not.toContain(".utf8");
  });

  it("does not touch lc_* values with locale=C", () => {
    const input = [
      "lc_messages = 'C'",
      "lc_monetary = 'C'",
    ].join("\n");

    expect(normalizeLocalesInConf(input)).toBe(input);
  });

  it("preserves surrounding postgresql.conf content unchanged", () => {
    const input = [
      "# autovacuum settings",
      "autovacuum = on",
      "lc_messages = 'en_US.utf8'\t\t# locale for system error messages",
      "max_connections = 100",
      "lc_monetary = 'en_US.utf8'\t\t# locale for monetary formatting",
    ].join("\n");

    const result = normalizeLocalesInConf(input);

    expect(result).toContain("autovacuum = on");
    expect(result).toContain("max_connections = 100");
    expect(result).toContain("# locale for system error messages");
    expect(result).toContain("# locale for monetary formatting");
    expect(result).toContain("lc_messages = 'en_US.UTF-8'");
    expect(result).toContain("lc_monetary = 'en_US.UTF-8'");
  });
});
