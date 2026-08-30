import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveNativeRunnerRuntimeRoot,
  seedNativeCodexHome,
} from "./native-codex-runner.js";

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanup].map((path) => rm(path, { recursive: true, force: true })));
  cleanup.clear();
});

describe("native Codex runner paths", () => {
  it("accepts only an absolute configured runtime root", () => {
    const absolute = resolve(tmpdir(), "paperclip-runner-runtime");
    expect(resolveNativeRunnerRuntimeRoot(absolute)).toBe(absolute);
    expect(() => resolveNativeRunnerRuntimeRoot("relative/runtime")).toThrow(
      "PAPERCLIP_RUNNER_RUNTIME_ROOT must be an absolute path",
    );
  });

  it("copies only portable Codex seed files into the local runtime home", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "paperclip-native-codex-home-"));
    cleanup.add(root);
    const source = resolve(root, "remote-source");
    const target = resolve(root, "local-target");
    seedNativeCodexHome(null, source);
    writeFileSync(resolve(source, "auth.json"), "{\"auth\":true}\n", "utf8");
    writeFileSync(resolve(source, "config.toml"), "model = \"gpt-5.6-sol\"\n", "utf8");
    writeFileSync(resolve(source, "state.sqlite"), "remote sqlite", "utf8");

    seedNativeCodexHome(source, target);

    expect(readFileSync(resolve(target, "auth.json"), "utf8")).toContain("auth");
    expect(readFileSync(resolve(target, "config.toml"), "utf8")).toContain("gpt-5.6-sol");
    expect(() => lstatSync(resolve(target, "state.sqlite"))).toThrow();
  });
});
