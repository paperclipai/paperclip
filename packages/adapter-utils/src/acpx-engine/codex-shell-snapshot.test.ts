import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyShellSnapshotPolicy,
  enforceCodexShellSnapshotPolicy,
} from "./codex-shell-snapshot.js";

const cleanupRoots: string[] = [];

// Codex reads this file at startup. A rewrite that produces invalid TOML — a
// duplicate `[features]` table, a duplicate key, a root key stranded after a
// table header — breaks every Codex run, so parse the result, don't just grep it.
function parsedFeatures(text: string): Record<string, unknown> {
  const parsed = parseToml(text) as { features?: Record<string, unknown> };
  return parsed.features ?? {};
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createCodexHome(configToml?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kee192-codex-"));
  cleanupRoots.push(root);
  const home = path.join(root, "codex-home");
  await fs.mkdir(home, { recursive: true });
  if (configToml !== undefined) {
    await fs.writeFile(path.join(home, "config.toml"), configToml, "utf8");
  }
  return home;
}

async function readConfig(home: string): Promise<string> {
  return await fs.readFile(path.join(home, "config.toml"), "utf8");
}

describe("applyShellSnapshotPolicy", () => {
  it("appends the managed table to a config with no features table", () => {
    const input = 'model = "gpt-5.6-sol"\n\n[projects."/"]\ntrust_level = "trusted"\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(true);
    expect(result.unsupported).toBeUndefined();
    // Root keys and the operator's tables survive; the managed table goes last,
    // because a TOML table header captures every root key that follows it.
    expect(result.text).toContain('model = "gpt-5.6-sol"');
    expect(result.text).toContain('[projects."/"]');
    expect(result.text.trimEnd().endsWith("# <<< paperclip codex runtime policy <<<")).toBe(true);
    expect(parseToml(result.text)).toMatchObject({
      model: "gpt-5.6-sol",
      features: { shell_snapshot: false },
    });
  });

  it("writes the key into an existing features table instead of declaring it twice", () => {
    const input = 'model = "gpt-5.6-sol"\n\n[features]\nweb_search = true\n\n[tui]\nnotify = true\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(true);
    expect(result.text.match(/^\[features\]$/gm)).toHaveLength(1);
    expect(parsedFeatures(result.text)).toEqual({ shell_snapshot: false, web_search: true });
    expect(parseToml(result.text)).toMatchObject({ tui: { notify: true } });
  });

  it("overrides an operator value of true and keeps only one assignment", () => {
    const input = "[features]\nshell_snapshot = true\nweb_search = true\n";

    const result = applyShellSnapshotPolicy(input);

    expect(result.text.match(/shell_snapshot\s*=/g)).toHaveLength(1);
    expect(parsedFeatures(result.text)).toEqual({ shell_snapshot: false, web_search: true });
  });

  it("does not touch a shell_snapshot key that belongs to another table", () => {
    const input = "[features]\nweb_search = true\n\n[other]\nshell_snapshot = true\n";

    const result = applyShellSnapshotPolicy(input);

    expect(parsedFeatures(result.text)).toEqual({ shell_snapshot: false, web_search: true });
    expect(parseToml(result.text)).toMatchObject({ other: { shell_snapshot: true } });
  });

  it("replaces a root-level dotted key", () => {
    const input = 'features.shell_snapshot = true\nmodel = "gpt-5.6-sol"\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.text).not.toContain("features.shell_snapshot");
    expect(parseToml(result.text)).toMatchObject({
      model: "gpt-5.6-sol",
      features: { shell_snapshot: false },
    });
  });

  it("is idempotent across runs", () => {
    const first = applyShellSnapshotPolicy('model = "gpt-5.6-sol"\n');
    const second = applyShellSnapshotPolicy(first.text);

    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
    expect(applyShellSnapshotPolicy(second.text).text).toBe(first.text);
  });

  it("refuses to rewrite an inline features table rather than breaking the file", () => {
    const input = "features = { web_search = true }\n";

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
    expect(result.unsupported).toContain("inline table");
  });
});

describe("enforceCodexShellSnapshotPolicy", () => {
  it("creates config.toml when the Codex home has none", async () => {
    const home = await createCodexHome();

    const notes = await enforceCodexShellSnapshotPolicy(home);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Disabled Codex shell snapshots");
    expect(parseToml(await readConfig(home))).toEqual({ features: { shell_snapshot: false } });
  });

  it("preserves a seeded operator config and stays quiet on the second run", async () => {
    const home = await createCodexHome('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n');

    expect(await enforceCodexShellSnapshotPolicy(home)).toHaveLength(1);
    const afterFirst = await readConfig(home);
    expect(parseToml(afterFirst)).toMatchObject({
      model: "gpt-5.6-sol",
      model_reasoning_effort: "high",
      features: { shell_snapshot: false },
    });

    expect(await enforceCodexShellSnapshotPolicy(home)).toEqual([]);
    expect(await readConfig(home)).toBe(afterFirst);
  });

  it("reports an inline features table instead of silently leaving snapshots on", async () => {
    const home = await createCodexHome("features = { web_search = true }\n");

    const notes = await enforceCodexShellSnapshotPolicy(home);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Left Codex shell snapshots enabled");
    expect(await readConfig(home)).toBe("features = { web_search = true }\n");
  });
});
