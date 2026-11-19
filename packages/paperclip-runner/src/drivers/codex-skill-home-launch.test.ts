import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../contracts/runtime-context.js";
import { NativeProviderStateIncompatibleError } from "../contracts/native-session-backend.js";
import { codexSkillReadRoots, createRunnerdCodexAppServerArgs } from "../live/runner-provider-launch.js";
import { resolveRunnerdCodexSkillInputs } from "../live/runnerd-codex-transport.js";
import {
  prepareSharedSkillHome,
  readCodexSkillHomeMarker,
  removeCodexSkillHomeTree,
  resolveRecordedCodexSkillHome,
  usesCodexSkillHome,
} from "./codex-skill-home.js";
import { prepareIsolatedCodexHome } from "./runtime-context-materializer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeCodexSkillHomeTree(root)));
});

function context(root: string): NativeRuntimeContextSnapshot {
  const digest = "0".repeat(64);
  const value = {
    prompt: {
      revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
      text: PAPERCLIP_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest,
        rootPath: join(root, "instructions"), fileCount: 1, totalBytes: 1 },
    },
    skills: [{
      key: "company/alpha",
      runtimeName: "alpha",
      versionId: "version-1",
      bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest: "a".repeat(64), manifestDigest: "a".repeat(64),
        rootPath: join(root, "bundles", "alpha"), fileCount: 2, totalBytes: 2 },
    }],
    mcp: { assignmentSetId: "set", digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-skill-home-launch-"));
  roots.push(root);
  await mkdir(join(root, "bundles", "alpha", "scripts"), { recursive: true });
  await writeFile(join(root, "bundles", "alpha", "SKILL.md"), "# alpha\n");
  await writeFile(join(root, "bundles", "alpha", "scripts", "run.sh"), "x".repeat(64 * 1024));
  return { root, storeRoot: join(root, "skill-homes"), assigned: context(root) };
}

async function regularBytes(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null);
  if (!info) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  for (const name of await readdir(path)) total += await regularBytes(join(path, name));
  return total;
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

describe("Codex launches with a shared skill home", () => {
  it("stores the skill bytes once for two sessions with the same skills", async () => {
    const { root, storeRoot, assigned } = await fixture();
    const a = await prepareIsolatedCodexHome({ context: assigned, codexHome: join(root, "a"), skillHomeStoreRoot: storeRoot });
    const b = await prepareIsolatedCodexHome({ context: assigned, codexHome: join(root, "b"), skillHomeStoreRoot: storeRoot });
    expect(a.skillHome).not.toBeNull();
    expect(b.skillHome).toBe(a.skillHome);
    expect(await exists(join(root, "a", "skills", "alpha"))).toBe(false);
    expect(await exists(join(root, "b", "skills", "alpha"))).toBe(false);
    const oneSet = await regularBytes(join(root, "bundles", "alpha"));
    const stored = await regularBytes(storeRoot) + await regularBytes(join(root, "a")) + await regularBytes(join(root, "b"));
    expect(stored).toBeLessThan(oneSet * 1.5);
    await expect(readCodexSkillHomeMarker(join(root, "a"))).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps copying into the session home without a store root", async () => {
    const { root, assigned } = await fixture();
    const result = await prepareIsolatedCodexHome({ context: assigned, codexHome: join(root, "a") });
    expect(result.skillHome).toBeNull();
    expect(await exists(join(root, "a", "skills", "alpha", "SKILL.md"))).toBe(true);
  });

  it("moves an old-layout session to the skill home", async () => {
    const { root, storeRoot, assigned } = await fixture();
    const codexHome = join(root, "old");
    await mkdir(join(codexHome, "skills", "alpha"), { recursive: true });
    await writeFile(join(codexHome, "skills", "alpha", "SKILL.md"), "# stale\n");
    const { skillHome } = await prepareIsolatedCodexHome({ context: assigned, codexHome, skillHomeStoreRoot: storeRoot });
    expect(await exists(join(codexHome, "skills", "alpha"))).toBe(false);
    expect(resolveRunnerdCodexSkillInputs([{ type: "skill", name: "alpha", path: join(root, "bundles", "alpha", "SKILL.md") }],
      assigned, codexHome, undefined, skillHome)).toEqual([
      { type: "skill", name: "alpha", path: join(skillHome!, ".agents", "skills", "alpha", "SKILL.md") },
    ]);
  });

  it("records the session's skill home before publishing it, so cleanup sees the reference", async () => {
    const { root, storeRoot, assigned } = await fixture();
    await writeFile(storeRoot, "not a directory");
    const codexHome = join(root, "a");
    await expect(prepareIsolatedCodexHome({ context: assigned, codexHome, skillHomeStoreRoot: storeRoot })).rejects.toThrow();
    await expect(readCodexSkillHomeMarker(codexHome)).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("prepares a shared skill home for any provider home and removes its old copy", async () => {
    const { root, storeRoot, assigned } = await fixture();
    const claudeHome = join(root, "claude-home");
    await mkdir(join(claudeHome, "skills", "alpha"), { recursive: true });
    await writeFile(join(claudeHome, "skills", "alpha", "SKILL.md"), "# stale\n");
    const { home, digest } = await prepareSharedSkillHome({ providerHome: claudeHome, storeRoot, context: assigned });
    expect(home).toBe(join(storeRoot, digest));
    expect(await exists(join(claudeHome, "skills", "alpha"))).toBe(false);
    await expect(readCodexSkillHomeMarker(claudeHome)).resolves.toBe(digest);
    expect(await exists(join(home, ".agents", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(await exists(join(storeRoot, `${digest}.last-used`))).toBe(true);
  });

  it("reuses the recorded home during recovery", async () => {
    const { root, storeRoot, assigned } = await fixture();
    const codexHome = join(root, "a");
    const { skillHome } = await prepareIsolatedCodexHome({ context: assigned, codexHome, skillHomeStoreRoot: storeRoot });
    await expect(resolveRecordedCodexSkillHome({ codexHome, storeRoot, context: null })).resolves.toBe(skillHome);
  });

  it("republishes a deleted recorded home from the runtime context", async () => {
    const { root, storeRoot, assigned } = await fixture();
    const codexHome = join(root, "a");
    const { skillHome } = await prepareIsolatedCodexHome({ context: assigned, codexHome, skillHomeStoreRoot: storeRoot });
    await removeCodexSkillHomeTree(skillHome!);
    await expect(resolveRecordedCodexSkillHome({ codexHome, storeRoot, context: assigned })).resolves.toBe(skillHome);
    expect(await exists(join(skillHome!, ".agents", "skills", "alpha", "SKILL.md"))).toBe(true);
  });

  it("refuses to recover without the recorded home or its context", async () => {
    const { root, storeRoot, assigned } = await fixture();
    const codexHome = join(root, "a");
    const { skillHome } = await prepareIsolatedCodexHome({ context: assigned, codexHome, skillHomeStoreRoot: storeRoot });
    await chmod(skillHome!, 0o700);
    await removeCodexSkillHomeTree(skillHome!);
    await expect(resolveRecordedCodexSkillHome({ codexHome, storeRoot, context: null }))
      .rejects.toThrow(NativeProviderStateIncompatibleError);
    await expect(resolveRecordedCodexSkillHome({ codexHome, storeRoot, context: null }))
      .rejects.toMatchObject({ code: "native_provider_state_incompatible", message: expect.stringContaining("codex_skill_home_unavailable") });
  });

  it.each([
    [{ provider: "codex", homeMode: "isolated" as const, codexSkillHomeStoreRoot: "/s" }, "linux", true],
    [{ provider: "codex", codexSkillHomeStoreRoot: "/s" }, "darwin", true],
    [{ provider: "codex", homeMode: "isolated" as const, codexSkillHomeStoreRoot: "/s" }, "win32", false],
    [{ provider: "codex", homeMode: "preconfigured" as const, codexSkillHomeStoreRoot: "/s" }, "linux", false],
    [{ provider: "codex", runnerFilesystemRoot: "/remote", codexSkillHomeStoreRoot: "/s" }, "linux", false],
    [{ provider: "codex" }, "linux", false],
    [{ provider: "acpx", codexSkillHomeStoreRoot: "/s" }, "linux", false],
  ] as const)("decides whether a launch uses a skill home (%o on %s)", (options, platform, expected) => {
    expect(usesCodexSkillHome(options, platform)).toBe(expected);
  });

  it("passes the skill home as HOME and grants only its skills read-only", () => {
    const serialized = createRunnerdCodexAppServerArgs({
      environment: { PATH: "/usr/bin:/bin" },
      codexHome: "/state/session/codex-home",
      skillHome: "/state/skill-homes/abc",
      readOnlyRoots: ["/state/skill-homes/abc/.agents/skills"],
    }).join("\n");
    expect(serialized).toContain('"/state/skill-homes/abc"="none"');
    expect(serialized).toContain('"/state/session/codex-home"="none"');
    expect(serialized).toContain('"/state/skill-homes/abc/.agents/skills"="read"');
  });

  it("keeps Codex's own system skills in the session home readable next to the skill home", () => {
    expect(codexSkillReadRoots("/state/session/codex-home", "/state/skill-homes/abc")).toEqual([
      resolve("/state/skill-homes/abc/.agents/skills"),
      resolve("/state/session/codex-home/skills"),
    ]);
    expect(codexSkillReadRoots("/state/session/codex-home", null)).toEqual([resolve("/state/session/codex-home/skills")]);
  });
});
