import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps the standalone Runner parser and schema synchronized with production", () => {
  expect(() => execFileSync(process.execPath, [
    fileURLToPath(new URL("../scripts/generate-runner-skill-frontmatter.ts", import.meta.url)),
    "--check",
  ])).not.toThrow();
});
