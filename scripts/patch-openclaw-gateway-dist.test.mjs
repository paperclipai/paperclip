import { spawnSync } from "node:child_process";

import { expect, test } from "vitest";

test("OpenClaw Gateway dist patch regression script passes", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./test-patch-openclaw-gateway-dist.mjs", import.meta.url).pathname],
    { encoding: "utf8" },
  );

  expect(result.status, result.stderr || result.stdout).toBe(0);
});
