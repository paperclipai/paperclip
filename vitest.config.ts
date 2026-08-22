import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultExclude, defineConfig } from "vitest/config";

// Vitest 4 dropped "**/dist/**" from its default `exclude` (the defaults are now
// only node_modules and .git), so every project that does not set its own
// `include` started collecting the COMPILED copies of its own tests out of
// dist/. Those are stale build artifacts that duplicate the src tests and
// inflate the suite's failure count. Root-level `test.exclude` is NOT inherited
// by projects, so it has to be applied per project — hence the map below.
const exclude = [...defaultExclude, "**/dist/**"];

const projectDirs = [
  "packages/shared",
  "packages/skills-catalog",
  "packages/db",
  "packages/adapter-utils",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/cursor-cloud",
  "packages/adapters/cursor-local",
  "packages/adapters/gemini-local",
  "packages/adapters/grok-local",
  "packages/adapters/kimi-local",
  "packages/adapters/openclaw-gateway",
  "packages/adapters/opencode-local",
  "packages/adapters/pi-local",
  "packages/plugins/sdk",
  "packages/plugins/create-paperclip-plugin",
  "server",
  "ui",
  "cli",
];

export default defineConfig({
  test: {
    projects: projectDirs.map((dir) => {
      const root = path.resolve(import.meta.dirname, dir);
      // An explicit `root` stops vitest deriving the project name from the
      // package, so restate the name it used to infer (`--project=<name>`
      // filters and reporter output depend on it).
      const pkg: { name: string } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      const config = path.join(root, "vitest.config.ts");
      // Projects that ship their own config keep it and only gain the exclude;
      // the rest are rooted at their directory on vitest's defaults.
      return existsSync(config)
        ? { extends: config, test: { name: pkg.name, root, exclude } }
        : { test: { name: pkg.name, root, exclude } };
    }),
  },
});
