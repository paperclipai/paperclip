import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LOCAL_RUN_DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/pelergy-trial/LOCAL-RUN.md",
);

describe("Pelergy trial local run doc", () => {
  it("exists with required sections", () => {
    expect(fs.existsSync(LOCAL_RUN_DOC_PATH)).toBe(true);

    const content = fs.readFileSync(LOCAL_RUN_DOC_PATH, "utf8");

    expect(content).toContain("# Pelergy Trial Local Run");
    expect(content).toContain("## One-Click Start");
    expect(content).toContain("## Verify The Instance");
  });

  it("documents one-click authenticated private run command", () => {
    const content = fs.readFileSync(LOCAL_RUN_DOC_PATH, "utf8");

    expect(content).toContain("pnpm paperclipai run --tailscale-auth");
    expect(content).toContain("PAPERCLIP_SECRETS_STRICT_MODE=true");
    expect(content).toContain("http://localhost:3100/api/health");
  });
});
