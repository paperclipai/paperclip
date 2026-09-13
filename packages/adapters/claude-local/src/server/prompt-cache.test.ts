import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareClaudePromptBundle, claudePromptBundleCanResume } from "./prompt-cache.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-context-")); roots.push(root);
  vi.stubEnv("PAPERCLIP_HOME", root);
  const source = path.join(root, "shipped", "paperclip"); await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "old shipped skill");
  const skill = { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source };
  const input = { companyId: "company", skills: [skill], shippedSkills: [skill], instructionsContents: "unchanged human instructions", onLog: async () => {} };
  const old = await prepareClaudePromptBundle(input);
  await fs.writeFile(path.join(source, "SKILL.md"), "new shipped skill");
  return { root, input, old, bundle: await prepareClaudePromptBundle(input) };
}
it("separates shipped-content caching from conversation compatibility, including old codecs", async () => {
  const { input, old, bundle } = await fixture();
  expect(old.bundleKey).not.toBe(bundle.bundleKey);
  expect(old.compatibilityKey).toBe(bundle.compatibilityKey);
  for (const previousCompatibilityKey of ["", old.compatibilityKey]) {
    expect(await claudePromptBundleCanResume({ ...input, bundle, previousBundleKey: old.bundleKey, previousCompatibilityKey })).toBe(true);
  }
});
it("does not ignore changed human instructions or lose the old cache", async () => {
  const { input, old, bundle } = await fixture();
  const changed = { ...input, instructionsContents: "changed human instructions" };
  const next = await prepareClaudePromptBundle(changed);
  for (const previousCompatibilityKey of ["", old.compatibilityKey]) {
    expect(await claudePromptBundleCanResume({ ...changed, bundle: next, previousBundleKey: old.bundleKey, previousCompatibilityKey })).toBe(false);
  }
  await fs.rm(old.rootDir, { recursive: true });
  expect(await claudePromptBundleCanResume({ ...input, bundle, previousBundleKey: old.bundleKey, previousCompatibilityKey: "" })).toBe(false);
});
it("hashes non-shipped content and refuses unknown old symlink content", async () => {
  const { root, input } = await fixture();
  const source = path.join(root, "third-party"); await fs.mkdir(source); await fs.writeFile(path.join(source, "SKILL.md"), "v1");
  const mixed = { ...input, skills: [...input.skills, { key: "custom", runtimeName: "custom", source }] };
  const old = await prepareClaudePromptBundle(mixed);
  await fs.writeFile(path.join(source, "SKILL.md"), "v2");
  const bundle = await prepareClaudePromptBundle(mixed);
  expect(bundle.compatibilityKey).not.toBe(old.compatibilityKey);
  for (const previousCompatibilityKey of ["", old.compatibilityKey]) {
    expect(await claudePromptBundleCanResume({ ...mixed, bundle, previousBundleKey: old.bundleKey, previousCompatibilityKey })).toBe(false);
  }
});
it("does not trust a reserved skill key from another source or version pin", async () => {
  const { root, input, old } = await fixture();
  const source = path.join(root, "override"); await fs.mkdir(source); await fs.writeFile(path.join(source, "SKILL.md"), "override");
  for (const skills of [[{ ...input.skills[0], source }], [{ ...input.skills[0], versionId: "pinned" }]]) {
    const changed = { ...input, skills }; const bundle = await prepareClaudePromptBundle(changed);
    expect(bundle.compatibilityKey).not.toBe(old.compatibilityKey);
    expect(await claudePromptBundleCanResume({ ...changed, bundle, previousBundleKey: old.bundleKey, previousCompatibilityKey: "" })).toBe(false);
  }
});
it("confines old bundle lookup to its company and refuses unknown skill sets", async () => {
  const { input, old, bundle } = await fixture();
  for (const change of [{ companyId: "other-company" }, { previousBundleKey: "../" + old.bundleKey }]) {
    expect(await claudePromptBundleCanResume({ ...input, bundle, previousBundleKey: old.bundleKey, previousCompatibilityKey: "", ...change })).toBe(false);
  }
  await fs.mkdir(path.join(old.rootDir, ".claude", "skills", "unexpected"));
  expect(await claudePromptBundleCanResume({ ...input, bundle, previousBundleKey: old.bundleKey, previousCompatibilityKey: "" })).toBe(false);
});

it("rejects an old third-party skill impersonating the shipped runtime name", async () => {
  const { root, input, old, bundle } = await fixture();
  const custom = path.join(root, "historical-custom"); await fs.mkdir(custom); await fs.writeFile(path.join(custom, "SKILL.md"), "custom instructions");
  const oldSkill = path.join(old.rootDir, ".claude", "skills", "paperclip");
  await fs.unlink(oldSkill); await fs.symlink(custom, oldSkill);
  expect(await claudePromptBundleCanResume({ ...input, bundle, previousBundleKey: old.bundleKey, previousCompatibilityKey: "" })).toBe(false);
});
