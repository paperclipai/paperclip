import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("paperclip issue update helper", () => {
  it("keeps the executable shebang LF-only", async () => {
    const helper = await readFile(
      path.join(repoRoot, "scripts/paperclip-issue-update.sh"),
    );
    const firstLineEnd = helper.indexOf(0x0a);

    expect(firstLineEnd).toBeGreaterThan(0);
    expect(helper.subarray(0, firstLineEnd + 1).toString("utf8")).toBe(
      "#!/usr/bin/env bash\n",
    );
  });
});
