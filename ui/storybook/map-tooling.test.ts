import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test("map sources combine without tracked index edits", () => {
  execFileSync(process.execPath, ["--test", "scripts/check-maps.test.mjs", "scripts/storybook-catalog.test.mjs", "scripts/storybook-feature-index.test.mjs"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdio: "pipe",
    timeout: 60_000,
  });
}, 65_000);
