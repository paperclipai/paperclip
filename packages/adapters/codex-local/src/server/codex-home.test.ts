import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareManagedCodexHome } from "./codex-home.js";

describe("prepareManagedCodexHome auth.json handling", () => {
  let scratch: string;
  let sharedHome: string;
  let managedHome: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-test-"));
    sharedHome = path.join(scratch, ".codex");
    managedHome = path.join(scratch, "managed");
    await fs.mkdir(sharedHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  function buildEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      PAPERCLIP_HOME: scratch,
      PAPERCLIP_INSTANCE_ID: "test",
      CODEX_HOME: sharedHome,
      ...overrides,
    };
  }

  it("symlinks auth.json into the managed home so the CLI follows token rotations", async () => {
    await fs.writeFile(path.join(sharedHome, "auth.json"), '{"token":"rotation-1"}', "utf8");

    await prepareManagedCodexHome(buildEnv(), async () => {}, "company-id");

    const target = path.join(scratch, "instances", "test", "companies", "company-id", "codex-home", "auth.json");
    const lst = await fs.lstat(target);
    expect(lst.isSymbolicLink()).toBe(true);

    // Rotate the source token, the managed link should reflect it immediately.
    await fs.writeFile(path.join(sharedHome, "auth.json"), '{"token":"rotation-2"}', "utf8");
    expect(await fs.readFile(target, "utf8")).toBe('{"token":"rotation-2"}');
  });

  // Regression for #5028: older Paperclip versions copied auth.json into the
  // managed home. After upgrading to the symlink-based logic, the stale copy
  // would not be replaced and the CLI would fail with refresh_token_reused as
  // soon as the source rotated.
  it("replaces a pre-existing copy of auth.json with a symlink on the next prepare call", async () => {
    const target = path.join(scratch, "instances", "test", "companies", "company-id", "codex-home", "auth.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Simulate a stale copy left by a previous Paperclip version.
    await fs.writeFile(target, '{"token":"stale-from-copy"}', "utf8");

    // The "live" auth file in the user's real ~/.codex has rotated since.
    await fs.writeFile(path.join(sharedHome, "auth.json"), '{"token":"fresh"}', "utf8");

    await prepareManagedCodexHome(buildEnv(), async () => {}, "company-id");

    const lst = await fs.lstat(target);
    expect(lst.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe('{"token":"fresh"}');
  });
});
