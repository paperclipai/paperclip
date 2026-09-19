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

// `homeMode` / `configMode` default to what a home Paperclip has already
// narrowed looks like, so the policy tests below see no mode note. The tests
// that care about narrowing pass the wide modes explicitly.
async function createCodexHome(
  configToml?: string,
  modes: { homeMode?: number; configMode?: number } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kee192-codex-"));
  cleanupRoots.push(root);
  const home = path.join(root, "codex-home");
  await fs.mkdir(home, { recursive: true, mode: modes.homeMode ?? 0o700 });
  if (configToml !== undefined) {
    await fs.writeFile(path.join(home, "config.toml"), configToml, {
      encoding: "utf8",
      mode: modes.configMode ?? 0o600,
    });
  }
  return home;
}

async function readConfig(home: string): Promise<string> {
  return await fs.readFile(path.join(home, "config.toml"), "utf8");
}

// Assert what is on disk, not the `mode` argument — it is masked by the process
// umask and ignored outright when the path already exists. "No group or other
// bits" rather than an exact 0600/0700: a stricter umask can only remove bits.
async function isPrivate(target: string): Promise<boolean> {
  return (((await fs.stat(target)).mode & 0o777) & 0o077) === 0;
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

  // KEE-216. A home created at 0755 with a 0644 config is what every install
  // that predates this had, and Codex writes `shell_snapshots/*.sh` into that
  // home itself — Paperclip never gets to pick their mode, so a private home is
  // the only thing keeping them from other accounts on the host.
  it("creates config.toml private", async () => {
    const home = await createCodexHome();

    await enforceCodexShellSnapshotPolicy(home);

    expect(await isPrivate(path.join(home, "config.toml"))).toBe(true);
  });

  it("narrows a world-readable home, and rewrites its config private", async () => {
    const home = await createCodexHome('model = "gpt-5.6-sol"\n', {
      homeMode: 0o755,
      configMode: 0o644,
    });
    expect(await isPrivate(home)).toBe(false);

    const notes = await enforceCodexShellSnapshotPolicy(home);

    expect(notes.some((note) => note.includes("Narrowed") && note.includes("0755"))).toBe(true);
    expect(notes.some((note) => note.includes("Disabled Codex shell snapshots"))).toBe(true);
    expect(await isPrivate(home)).toBe(true);
    expect(await isPrivate(path.join(home, "config.toml"))).toBe(true);
    // Narrowing must not cost the operator their settings.
    expect(parseToml(await readConfig(home))).toMatchObject({
      model: "gpt-5.6-sol",
      features: { shell_snapshot: false },
    });
  });

  it("narrows the home even when the policy is already in force", async () => {
    // The config is already correct, so the writer returns early. The mode
    // repair still has to run, or a home seeded before KEE-216 stays at 0755
    // forever with its old snapshots inside it.
    const home = await createCodexHome(applyShellSnapshotPolicy("").text, {
      homeMode: 0o755,
    });

    const notes = await enforceCodexShellSnapshotPolicy(home);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Narrowed");
    expect(await isPrivate(home)).toBe(true);
  });

  it("leaves an unsupported config alone but still narrows the home", async () => {
    const home = await createCodexHome("features = { web_search = true }\n", {
      homeMode: 0o755,
    });

    const notes = await enforceCodexShellSnapshotPolicy(home);

    expect(notes.some((note) => note.includes("Left Codex shell snapshots enabled"))).toBe(true);
    expect(await isPrivate(home)).toBe(true);
    expect(await readConfig(home)).toBe("features = { web_search = true }\n");
  });
});
