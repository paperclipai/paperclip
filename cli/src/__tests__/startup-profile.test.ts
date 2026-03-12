import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRecentLaunchHistory, readRepoStartupProfile } from "../config/startup-profile.js";

const tempRoots: string[] = [];

function createRepoRoot(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `paperclip-${name}-`));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("repo startup profile helpers", () => {
  it("finds the repo-local startup profile from nested working directories", () => {
    const repoRoot = createRepoRoot("cli-profile");
    const nestedDir = path.join(repoRoot, "packages", "feature");
    fs.mkdirSync(path.join(repoRoot, ".paperclip"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".paperclip", "local-start.json"),
      JSON.stringify({
        paperclipHome: "/tmp/paperclip-home",
        instanceId: "default",
        configPath: "/tmp/paperclip-home/instances/default/config.json",
      }),
    );

    const profile = readRepoStartupProfile(nestedDir);
    expect(profile?.profilePath).toBe(path.join(repoRoot, ".paperclip", "local-start.json"));
    expect(profile?.instanceId).toBe("default");
  });

  it("reads recent launch history from the pinned instance", () => {
    const repoRoot = createRepoRoot("cli-history");
    const paperclipHome = path.join(repoRoot, "runtime-home");
    const historyPath = path.join(
      paperclipHome,
      "instances",
      "default",
      "logs",
      "launch-history.jsonl",
    );
    fs.mkdirSync(path.join(repoRoot, ".paperclip"), { recursive: true });
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".paperclip", "local-start.json"),
      JSON.stringify({
        paperclipHome,
        instanceId: "default",
        configPath: path.join(paperclipHome, "instances", "default", "config.json"),
      }),
    );
    fs.writeFileSync(
      historyPath,
      [
        JSON.stringify({ recordedAt: "2026-03-10T10:00:00.000Z", result: "ready" }),
        JSON.stringify({ recordedAt: "2026-03-10T10:05:00.000Z", result: "failed" }),
      ].join("\n"),
    );

    const profile = readRepoStartupProfile(repoRoot);
    expect(profile).not.toBeNull();
    expect(readRecentLaunchHistory(profile!, 10)).toEqual([
      { recordedAt: "2026-03-10T10:00:00.000Z", result: "ready" },
      { recordedAt: "2026-03-10T10:05:00.000Z", result: "failed" },
    ]);
  });
});
