import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveBuildCommit } from "../../scripts/write-build-stamp.mjs";

it("packages a full source commit without a Docker build argument", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-build-stamp-")));
  try {
    const scriptDir = join(root, "server", "scripts");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "write-build-stamp.mjs");
    copyFileSync(new URL("../../scripts/write-build-stamp.mjs", import.meta.url), script);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--quiet");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "--no-gpg-sign", "-m", "fixture");
    const env = { ...process.env };
    delete env.PAPERCLIP_BUILD_COMMIT;
    execFileSync(process.execPath, [script], { cwd: root, env, stdio: "pipe" });
    const stamp = JSON.parse(readFileSync(join(root, "server", "dist", "build-info.json"), "utf8"));
    expect(stamp.commit).toBe(git("rev-parse", "HEAD"));
    expect(stamp.commit).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveBuildCommit", () => {
  it("prefers the git commit over the supplied environment commit", () => {
    expect(resolveBuildCommit("aaaaaaa", "bbbbbbb")).toBe("aaaaaaa");
  });

  it("falls back to PAPERCLIP_BUILD_COMMIT when git gives no commit", () => {
    // A Docker image build excludes `.git`, so the git lookup returns null. The
    // image build passes the commit in the environment instead.
    expect(resolveBuildCommit(null, "bbbbbbb")).toBe("bbbbbbb");
  });

  it("trims the supplied commit", () => {
    expect(resolveBuildCommit(null, "  bbbbbbb\n")).toBe("bbbbbbb");
  });

  it("returns null when neither git nor the environment gives a commit", () => {
    expect(resolveBuildCommit(null, undefined)).toBe(null);
  });

  it("treats an empty supplied commit as absent", () => {
    expect(resolveBuildCommit(null, "")).toBe(null);
    expect(resolveBuildCommit(null, "   ")).toBe(null);
  });
});
