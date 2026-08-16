import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // Pin the clock's timezone so date rendering is the same everywhere.
    //
    // Several suites supply a UTC instant and assert on the local-time string
    // the UI renders from it — "2026-07-17T16:08:00.000Z" is expected to read
    // "Today, 4:08 PM". That only holds where local time is UTC. CI passes
    // because GitHub's runners happen to default to UTC; a contributor in any
    // other zone sees those tests fail on a clean checkout, which reads as
    // "the suite is broken" rather than "your clock differs".
    env: { TZ: "UTC" },
  },
});
