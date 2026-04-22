import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedCodexHomeFromShared } from "./codex-home.js";

describe("seedCodexHomeFromShared", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDir(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    tempDirs.push(dir);
    return dir;
  }

  it("seeds explicit Codex homes from the shared authenticated home", async () => {
    const sourceHome = createTempDir("paperclip-codex-shared");
    const targetHome = createTempDir("paperclip-codex-target");
    const onLog = vi.fn(async () => {});

    fs.writeFileSync(path.join(sourceHome, "auth.json"), '{"token":"redacted"}');
    fs.writeFileSync(path.join(sourceHome, "config.toml"), 'model = "gpt-5.4"\n');
    fs.writeFileSync(path.join(sourceHome, "instructions.md"), "# shared\n");

    await seedCodexHomeFromShared(
      targetHome,
      { CODEX_HOME: sourceHome },
      onLog,
      "adapter-config override",
    );

    const authStat = fs.lstatSync(path.join(targetHome, "auth.json"));
    expect(authStat.isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(targetHome, "auth.json"))).toBe(
      fs.realpathSync(path.join(sourceHome, "auth.json")),
    );
    expect(fs.readFileSync(path.join(targetHome, "config.toml"), "utf8")).toBe(
      'model = "gpt-5.4"\n',
    );
    expect(fs.readFileSync(path.join(targetHome, "instructions.md"), "utf8")).toBe("# shared\n");
    expect(onLog).toHaveBeenCalledOnce();
  });

  it("preserves existing override-local config files while still wiring shared auth", async () => {
    const sourceHome = createTempDir("paperclip-codex-shared");
    const targetHome = createTempDir("paperclip-codex-target");
    const onLog = vi.fn(async () => {});

    fs.writeFileSync(path.join(sourceHome, "auth.json"), '{"token":"redacted"}');
    fs.writeFileSync(path.join(sourceHome, "config.toml"), 'model = "shared"\n');
    fs.writeFileSync(path.join(targetHome, "config.toml"), 'model = "override"\n');

    await seedCodexHomeFromShared(
      targetHome,
      { CODEX_HOME: sourceHome },
      onLog,
      "adapter-config override",
    );

    expect(fs.realpathSync(path.join(targetHome, "auth.json"))).toBe(
      fs.realpathSync(path.join(sourceHome, "auth.json")),
    );
    expect(fs.readFileSync(path.join(targetHome, "config.toml"), "utf8")).toBe(
      'model = "override"\n',
    );
  });
});
