import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveServerDevWatchIgnorePaths } from "./dev-watch-ignore.js";

const SERVER_ROOT = "/app/server";
const TEST_HOME = "/home/testuser";

describe("resolveServerDevWatchIgnorePaths", () => {
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    process.env.HOME = TEST_HOME;
  });

  afterEach(() => {
    process.env.HOME = origHome;
  });

  it("always includes the node_modules / bower_components glob pattern", () => {
    const result = resolveServerDevWatchIgnorePaths(SERVER_ROOT);
    expect(result).toContain("**/{node_modules,bower_components,vendor}/**");
  });

  it("always includes the .vite-temp glob pattern", () => {
    const result = resolveServerDevWatchIgnorePaths(SERVER_ROOT);
    expect(result).toContain("**/.vite-temp/**");
  });

  it("includes absolute path to ui/node_modules", () => {
    const result = resolveServerDevWatchIgnorePaths(SERVER_ROOT);
    const expected = path.resolve(SERVER_ROOT, "../ui/node_modules");
    expect(result).toContain(expected);
  });

  it("includes globstar path for ui/node_modules", () => {
    const result = resolveServerDevWatchIgnorePaths(SERVER_ROOT);
    const base = path.resolve(SERVER_ROOT, "../ui/node_modules");
    expect(result).toContain(`${base}/**`);
  });

  it("includes absolute path to ui/dist", () => {
    const result = resolveServerDevWatchIgnorePaths(SERVER_ROOT);
    const expected = path.resolve(SERVER_ROOT, "../ui/dist");
    expect(result).toContain(expected);
  });

  it("includes globstar path for ui/dist", () => {
    const result = resolveServerDevWatchIgnorePaths(SERVER_ROOT);
    const base = path.resolve(SERVER_ROOT, "../ui/dist");
    expect(result).toContain(`${base}/**`);
  });

  it("includes HOME-based adapter-plugins path", () => {
    const result = resolveServerDevWatchIgnorePaths(SERVER_ROOT);
    expect(result).toContain(`${TEST_HOME}/.paperclip/adapter-plugins`);
  });

  it("returns an array with no duplicate entries", () => {
    const result = resolveServerDevWatchIgnorePaths(SERVER_ROOT);
    expect(Array.isArray(result)).toBe(true);
    expect(new Set(result).size).toBe(result.length);
  });

  it("works with a different serverRoot without throwing", () => {
    expect(() => resolveServerDevWatchIgnorePaths("/opt/project/server")).not.toThrow();
  });
});
