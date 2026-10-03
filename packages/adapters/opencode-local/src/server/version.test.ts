import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyOpenCodeLine,
  detectOpenCodeVersion,
  parseOpenCodeVersion,
  semverAtLeast,
} from "./version.js";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-version-seam-"));

// Real executable fixture: a tiny sh script under the OS temp dir that shells
// out to `node -e` to print one probe-observed `opencode --version` shape.
function writeFixtureScript(name: string, nodeCode: string): string {
  const file = path.join(fixtureDir, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec node -e '${nodeCode}'\n`, {
    mode: 0o755,
  });
  return file;
}

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe("parseOpenCodeVersion", () => {
  it("parses the v1 bare semver banner", () => {
    expect(parseOpenCodeVersion("1.18.32\n")).toEqual({
      raw: "1.18.32",
      major: 1,
      minor: 18,
      patch: 32,
    });
  });

  it("parses the v2 opencode-prefixed banner", () => {
    expect(parseOpenCodeVersion("opencode v2.0.18\n")).toEqual({
      raw: "opencode v2.0.18",
      major: 2,
      minor: 0,
      patch: 18,
    });
    expect(parseOpenCodeVersion("opencode v2.0.1\n")).toEqual({
      raw: "opencode v2.0.1",
      major: 2,
      minor: 0,
      patch: 1,
    });
  });

  it("tolerates surrounding whitespace, a bare v prefix, and banner noise", () => {
    expect(parseOpenCodeVersion("\r\n  \tv2.0.18  \r\n")).toEqual({
      raw: "v2.0.18",
      major: 2,
      minor: 0,
      patch: 18,
    });
    expect(parseOpenCodeVersion("warning: fetching release metadata\n1.18.32")).toEqual({
      raw: "1.18.32",
      major: 1,
      minor: 18,
      patch: 32,
    });
  });

  it("returns null for garbage instead of guessing", () => {
    expect(parseOpenCodeVersion("")).toBeNull();
    expect(parseOpenCodeVersion("   \n\t\n")).toBeNull();
    expect(parseOpenCodeVersion("command not found")).toBeNull();
    expect(parseOpenCodeVersion("opencode")).toBeNull();
    expect(parseOpenCodeVersion("opencode v2.0")).toBeNull();
    expect(parseOpenCodeVersion("version 9.9.9")).toBeNull();
    expect(parseOpenCodeVersion("error: expected 1.2.3 but got 4.5.6")).toBeNull();
  });
});

describe("classifyOpenCodeLine", () => {
  it("maps parsed majors onto adapter lines", () => {
    expect(classifyOpenCodeLine({ major: 1 })).toBe("v1");
    expect(classifyOpenCodeLine({ major: 2 })).toBe("v2");
    expect(classifyOpenCodeLine({ major: 3 })).toBe("v2");
    expect(classifyOpenCodeLine({ major: 0 })).toBe("unknown");
    expect(classifyOpenCodeLine(null)).toBe("unknown");
  });
});

describe("semverAtLeast", () => {
  const floor = { major: 2, minor: 0, patch: 18 };

  it("treats the 2.0.18 floor as inclusive", () => {
    expect(semverAtLeast({ major: 2, minor: 0, patch: 18 }, floor)).toBe(true);
    expect(semverAtLeast({ major: 2, minor: 0, patch: 17 }, floor)).toBe(false);
    expect(semverAtLeast({ major: 2, minor: 1, patch: 0 }, floor)).toBe(true);
    expect(semverAtLeast({ major: 1, minor: 99, patch: 99 }, floor)).toBe(false);
    expect(semverAtLeast({ major: 3, minor: 0, patch: 0 }, floor)).toBe(true);
    expect(semverAtLeast(null, floor)).toBe(false);
  });
});

describe("detectOpenCodeVersion", () => {
  const baseOptions = { cwd: fixtureDir, env: process.env };

  it("detects the v2 banner from a working command", async () => {
    const script = writeFixtureScript(
      "opencode-v2.sh",
      'console.log("opencode v2.0.18")',
    );
    await expect(detectOpenCodeVersion(script, baseOptions)).resolves.toEqual({
      raw: "opencode v2.0.18",
      major: 2,
      minor: 0,
      patch: 18,
      line: "v2",
    });
  });

  it("detects the v1 bare banner from a working command", async () => {
    const script = writeFixtureScript(
      "opencode-v1.sh",
      'console.log("1.18.32")',
    );
    await expect(detectOpenCodeVersion(script, baseOptions)).resolves.toEqual({
      raw: "1.18.32",
      major: 1,
      minor: 18,
      patch: 32,
      line: "v1",
    });
  });

  it("falls back to stderr when the banner never reaches stdout", async () => {
    const script = writeFixtureScript(
      "opencode-stderr.sh",
      'process.stderr.write("opencode v2.0.1\\n"); process.exitCode = 1',
    );
    await expect(detectOpenCodeVersion(script, baseOptions)).resolves.toEqual({
      raw: "opencode v2.0.1",
      major: 2,
      minor: 0,
      patch: 1,
      line: "v2",
    });
  });

  it("returns null when the command does not exist", async () => {
    await expect(
      detectOpenCodeVersion(path.join(fixtureDir, "missing-opencode"), baseOptions),
    ).resolves.toBeNull();
    await expect(
      detectOpenCodeVersion("definitely-not-a-real-opencode-binary", baseOptions),
    ).resolves.toBeNull();
  });

  it("returns null when the command prints no parseable version", async () => {
    const script = writeFixtureScript(
      "opencode-garbage.sh",
      'console.log("opencode exploded")',
    );
    await expect(detectOpenCodeVersion(script, baseOptions)).resolves.toBeNull();
  });

  it(
    "returns null instead of throwing when the command outruns the timeout",
    async () => {
      const script = writeFixtureScript(
        "opencode-hangs.sh",
        "setInterval(() => {}, 1000)",
      );
      await expect(
        detectOpenCodeVersion(script, { ...baseOptions, timeoutMs: 500 }),
      ).resolves.toBeNull();
    },
    15_000,
  );
});
