import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

describe("server build configuration", () => {
  it("compiles the build without colocated tests or test helpers", () => {
    const build = read("tsconfig.build.json");
    expect(build.extends).toBe("./tsconfig.json");
    expect(build.exclude).toEqual(expect.arrayContaining(["src/__tests__", "src/**/__tests__", "src/**/*.test.ts"]));
  });

  it("builds from the build configuration with two checkers", () => {
    const script: string = read("package.json").scripts.build;
    expect(script).toMatch(/(^|&& )tsc -p tsconfig\.build\.json --checkers 2( |$)/);
  });

  it("keeps colocated tests in the type-checked configuration", () => {
    const project = read("tsconfig.json");
    expect(project.exclude ?? []).not.toContain("src/**/*.test.ts");
  });
});
