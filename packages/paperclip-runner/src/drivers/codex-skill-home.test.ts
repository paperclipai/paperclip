import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../contracts/runtime-context.js";
import {
  claudeSkillPluginDirectory,
  codexSkillHomeDigest,
  ensureCodexSkillHome,
  readCodexSkillHomeMarker,
  verifyCodexSkillHome,
  writeCodexSkillHomeMarker,
} from "./codex-skill-home.js";

const roots: string[] = [];

async function makeWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) await makeWritable(join(root, entry));
  } else {
    await chmod(root, 0o600);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

const digestOf = (character: string) => character.repeat(64);

function skill(runtimeName: string, rootPath: string, digest: string) {
  return {
    key: `company/${runtimeName}`,
    runtimeName,
    versionId: "version-1",
    bundle: {
      schema: NATIVE_RUNTIME_ASSET_SCHEMA,
      digest,
      manifestDigest: digest,
      rootPath,
      fileCount: 2,
      totalBytes: 2,
    },
  };
}

function context(skills: ReturnType<typeof skill>[]): NativeRuntimeContextSnapshot {
  const digest = digestOf("0");
  const value = {
    prompt: {
      revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
      text: PAPERCLIP_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: "/instructions",
        fileCount: 1,
        totalBytes: 1,
      },
    },
    skills,
    mcp: { assignmentSetId: "set", digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-skill-home-"));
  roots.push(root);
  for (const name of ["alpha", "beta"]) {
    await mkdir(join(root, "bundles", name, "scripts"), { recursive: true });
    await writeFile(join(root, "bundles", name, "SKILL.md"), `# ${name}\n`);
    await writeFile(join(root, "bundles", name, "scripts", "run.sh"), "echo run\n");
  }
  const storeRoot = join(root, "skill-homes");
  const assigned = context([
    skill("alpha", join(root, "bundles", "alpha"), digestOf("a")),
    skill("beta", join(root, "bundles", "beta"), digestOf("b")),
  ]);
  return { root, storeRoot, assigned };
}

async function homeEntries(storeRoot: string): Promise<string[]> {
  return (await readdir(storeRoot)).filter((name) => /^[a-f0-9]{64}$/.test(name));
}

describe("Codex skill home store", () => {
  it("publishes one home for the same skills", async () => {
    const { storeRoot, assigned } = await fixture();
    const first = await ensureCodexSkillHome({ storeRoot, context: assigned });
    const second = await ensureCodexSkillHome({ storeRoot, context: assigned });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.home).toBe(first.home);
    expect(first.home).toBe(join(storeRoot, first.digest));
    const entry = join(first.home, ".agents", "skills", "alpha", "SKILL.md");
    await expect(readFile(entry, "utf8")).resolves.toBe("# alpha\n");
    expect((await stat(entry)).mode & 0o222).toBe(0);
    expect(await homeEntries(storeRoot)).toEqual([first.digest]);
  });

  it("publishes a Claude plugin manifest next to the skills", async () => {
    const { storeRoot, assigned } = await fixture();
    const { home } = await ensureCodexSkillHome({ storeRoot, context: assigned });
    expect(JSON.parse(await readFile(join(home, ".agents", ".claude-plugin", "plugin.json"), "utf8")))
      .toEqual({ name: "paperclip", version: "2.0.0", description: "Skills assigned by Paperclip" });
    expect(claudeSkillPluginDirectory(home)).toBe(join(home, ".agents"));
    const record = JSON.parse(await readFile(join(storeRoot, `${basename(home)}.stat.json`), "utf8"));
    expect(record.files.map((entry: unknown[]) => entry[0])).toContain(".agents/.claude-plugin/plugin.json");
  });

  it("uses a new home for a new bundle digest", async () => {
    const { root, storeRoot, assigned } = await fixture();
    const first = await ensureCodexSkillHome({ storeRoot, context: assigned });
    const changed = context([
      skill("alpha", join(root, "bundles", "alpha"), digestOf("a")),
      skill("beta", join(root, "bundles", "beta"), digestOf("c")),
    ]);
    const second = await ensureCodexSkillHome({ storeRoot, context: changed });
    expect(second.home).not.toBe(first.home);
    expect(second.created).toBe(true);
  });

  it("derives the digest from names and bundle digests, not paths or order", () => {
    const a = context([skill("alpha", "/one/alpha", digestOf("a")), skill("beta", "/one/beta", digestOf("b"))]);
    const b = context([skill("beta", "/two/beta", digestOf("b")), skill("alpha", "/two/alpha", digestOf("a"))]);
    expect(codexSkillHomeDigest(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(codexSkillHomeDigest(b)).toBe(codexSkillHomeDigest(a));
  });

  it.each([
    ["an equal-size edit with restored times", async (home: string) => {
      const target = join(home, ".agents", "skills", "alpha", "SKILL.md");
      const before = await stat(target);
      await writeFile(target, "# ALPHA\n");
      await utimes(target, before.atime, before.mtime);
    }],
    ["an extra file", async (home: string) => {
      await writeFile(join(home, ".agents", "skills", "alpha", "extra.md"), "x");
    }],
    ["a missing file", async (home: string) => {
      await rm(join(home, ".agents", "skills", "beta", "scripts", "run.sh"));
    }],
    ["an edited Claude plugin manifest", async (home: string) => {
      await writeFile(join(home, ".agents", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "other" }));
    }],
    ["a file replaced by a symlink", async (home: string) => {
      const target = join(home, ".agents", "skills", "alpha", "SKILL.md");
      await rm(target);
      await symlink("/etc/hostname", target);
    }],
  ])("detects %s on reuse and republishes", async (_label, tamper) => {
    const { storeRoot, assigned } = await fixture();
    const first = await ensureCodexSkillHome({ storeRoot, context: assigned });
    await makeWritable(first.home);
    await tamper(first.home);
    await expect(verifyCodexSkillHome(first.home)).rejects.toThrow("codex_skill_home_integrity_failed");
    const second = await ensureCodexSkillHome({ storeRoot, context: assigned });
    expect(second.created).toBe(true);
    expect(second.home).toBe(first.home);
    await expect(verifyCodexSkillHome(second.home)).resolves.toBeUndefined();
    expect(await readdir(join(storeRoot, "quarantine"))).toHaveLength(1);
  });

  it("records file identities after sealing and reuses the home by them", async () => {
    const { storeRoot, assigned } = await fixture();
    const first = await ensureCodexSkillHome({ storeRoot, context: assigned });
    const record = JSON.parse(await readFile(join(storeRoot, `${first.digest}.stat.json`), "utf8"));
    expect(record.files.map((entry: unknown[]) => entry[0])).toEqual([
      ".agents/.claude-plugin/plugin.json", ".agents/skills/alpha/SKILL.md", ".agents/skills/alpha/scripts/run.sh",
      ".agents/skills/beta/SKILL.md", ".agents/skills/beta/scripts/run.sh", "manifest.json",
    ]);
    // A home whose stat record is lost is still verified by content and gets a new record.
    await rm(join(storeRoot, `${first.digest}.stat.json`));
    const second = await ensureCodexSkillHome({ storeRoot, context: assigned });
    expect(second.created).toBe(false);
    await expect(readFile(join(storeRoot, `${first.digest}.stat.json`), "utf8")).resolves.toContain("manifest.json");
  });

  it("detects a tampered manifest that matches tampered content", async () => {
    const { storeRoot, assigned } = await fixture();
    const first = await ensureCodexSkillHome({ storeRoot, context: assigned });
    await makeWritable(first.home);
    await writeFile(join(first.home, ".agents", "skills", "alpha", "SKILL.md"), "# ALPHA\n");
    const manifestPath = join(first.home, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[0].sha256 = "f".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const second = await ensureCodexSkillHome({ storeRoot, context: assigned });
    expect(second.created).toBe(true);
    await expect(readFile(join(second.home, ".agents", "skills", "alpha", "SKILL.md"), "utf8")).resolves.toBe("# alpha\n");
  });

  it("does not quarantine a home another launch replaced after it was judged damaged", async () => {
    const { storeRoot, assigned } = await fixture();
    const first = await ensureCodexSkillHome({ storeRoot, context: assigned });
    await makeWritable(first.home);
    await writeFile(join(first.home, ".agents", "skills", "alpha", "extra.md"), "x");
    let replaced = false;
    const result = await ensureCodexSkillHome({ storeRoot, context: assigned }, {
      beforeQuarantine: async () => {
        if (replaced) return;
        replaced = true;
        await ensureCodexSkillHome({ storeRoot, context: assigned });
      },
    });
    expect(result.created).toBe(false);
    await expect(verifyCodexSkillHome(result.home)).resolves.toBeUndefined();
    expect(await readdir(join(storeRoot, "quarantine"))).toHaveLength(1);
  });

  it("republishes when a damaged home vanished before it could be quarantined", async () => {
    const { storeRoot, assigned } = await fixture();
    const first = await ensureCodexSkillHome({ storeRoot, context: assigned });
    await makeWritable(first.home);
    await writeFile(join(first.home, ".agents", "skills", "alpha", "extra.md"), "x");
    const result = await ensureCodexSkillHome({ storeRoot, context: assigned }, {
      beforeQuarantine: async () => { await rm(first.home, { recursive: true, force: true }); },
    });
    expect(result.created).toBe(true);
    await expect(verifyCodexSkillHome(result.home)).resolves.toBeUndefined();
  });

  it("publishes one home when two launches race", async () => {
    const { storeRoot, assigned } = await fixture();
    const results = await Promise.all([
      ensureCodexSkillHome({ storeRoot, context: assigned }),
      ensureCodexSkillHome({ storeRoot, context: assigned }),
    ]);
    expect(results[0].home).toBe(results[1].home);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await readdir(storeRoot)).filter((name) => name.startsWith(".staging-"))).toEqual([]);
    await expect(verifyCodexSkillHome(results[0].home)).resolves.toBeUndefined();
  });

  it("round-trips the session marker and ignores a malformed one", async () => {
    const { root } = await fixture();
    const codexHome = join(root, "codex-home");
    await expect(readCodexSkillHomeMarker(codexHome)).resolves.toBeNull();
    await writeCodexSkillHomeMarker(codexHome, digestOf("d"));
    await expect(readCodexSkillHomeMarker(codexHome)).resolves.toBe(digestOf("d"));
    await writeFile(join(codexHome, "paperclip-skill-home.json"), "{not json");
    await expect(readCodexSkillHomeMarker(codexHome)).resolves.toBeNull();
  });

  it("ignores a marker an agent replaced with a link or an oversized file", async () => {
    const { root } = await fixture();
    const codexHome = join(root, "codex-home");
    const elsewhere = join(root, "elsewhere.json");
    await mkdir(codexHome, { recursive: true });
    await writeFile(elsewhere, JSON.stringify({ schema: "paperclip.codex-skill-home-ref.v1", digest: digestOf("e") }));
    await symlink(elsewhere, join(codexHome, "paperclip-skill-home.json"));
    await expect(readCodexSkillHomeMarker(codexHome)).resolves.toBeNull();
    await rm(join(codexHome, "paperclip-skill-home.json"));
    await writeFile(join(codexHome, "paperclip-skill-home.json"),
      JSON.stringify({ schema: "paperclip.codex-skill-home-ref.v1", digest: digestOf("e"), padding: "x".repeat(64 * 1024) }));
    await expect(readCodexSkillHomeMarker(codexHome)).resolves.toBeNull();
  });
});
