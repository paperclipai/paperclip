import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildZaiSkillInjection } from "./skills-content.js";

async function makeSkillsTree(skills: Array<{ key: string; name: string; body: string; required?: boolean }>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zai-skills-"));
  await fs.mkdir(root, { recursive: true });
  const entries = skills.map((skill) => ({
    key: skill.key,
    runtimeName: skill.name,
    source: path.join(root, skill.name),
    required: skill.required ?? false,
    requiredReason: null,
  }));
  for (let i = 0; i < skills.length; i++) {
    const dir = entries[i].source;
    await fs.mkdir(dir, { recursive: true });
    const frontmatter = skills[i].required ? "" : "---\nrequired: false\n---\n";
    await fs.writeFile(path.join(dir, "SKILL.md"), `${frontmatter}${skills[i].body}`, "utf8");
  }
  return { root, entries };
}

describe("buildZaiSkillInjection", () => {
  let cleanupRoot: string | null = null;
  afterEach(async () => {
    if (cleanupRoot) {
      await fs.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {});
      cleanupRoot = null;
    }
  });

  it("returns empty when no skills are configured/desired", async () => {
    // Pass an explicit non-empty (but non-required, non-desired) catalog so the
    // helper short-circuits filesystem discovery and the injection naturally
    // ends up empty.
    const result = await buildZaiSkillInjection({
      paperclipRuntimeSkills: [
        {
          key: "paperclipai/paperclip/optional-only",
          runtimeName: "optional-only",
          source: "/nonexistent/path",
          required: false,
        },
      ],
    });
    expect(result.systemPromptAddendum).toBe("");
    expect(result.injectedKeys).toEqual([]);
  });

  it("injects bodies of desired skills into a single addendum, stripping frontmatter", async () => {
    const { root, entries } = await makeSkillsTree([
      { key: "paperclipai/paperclip/foo", name: "foo", body: "# Foo skill\n\nDo foo things." },
      { key: "paperclipai/paperclip/bar", name: "bar", body: "# Bar skill\n\nDo bar things." },
    ]);
    cleanupRoot = root;

    const config = {
      paperclipRuntimeSkills: entries.map((e) => ({
        key: e.key,
        runtimeName: e.runtimeName,
        source: e.source,
        required: e.required,
      })),
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/foo"],
      },
    };

    const result = await buildZaiSkillInjection(config);
    expect(result.injectedKeys).toEqual(["paperclipai/paperclip/foo"]);
    expect(result.skippedKeys).toEqual([]);
    expect(result.systemPromptAddendum).toContain("# Foo skill");
    expect(result.systemPromptAddendum).not.toContain("required: false");
    expect(result.systemPromptAddendum).not.toContain("# Bar skill");
  });

  it("warns and skips when a desired skill key is not in the available set", async () => {
    const { root, entries } = await makeSkillsTree([
      { key: "paperclipai/paperclip/foo", name: "foo", body: "# Foo body" },
    ]);
    cleanupRoot = root;

    const config = {
      paperclipRuntimeSkills: entries.map((e) => ({
        key: e.key,
        runtimeName: e.runtimeName,
        source: e.source,
        required: e.required,
      })),
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/foo", "paperclipai/paperclip/missing"],
      },
    };

    const result = await buildZaiSkillInjection(config);
    expect(result.injectedKeys).toEqual(["paperclipai/paperclip/foo"]);
    expect(result.skippedKeys).toContain("paperclipai/paperclip/missing");
    expect(result.warnings.some((w) => w.includes("not available locally"))).toBe(true);
  });

  it("auto-includes 'required' skills even without explicit selection", async () => {
    const { root, entries } = await makeSkillsTree([
      { key: "paperclipai/paperclip/required-one", name: "required-one", body: "# Always on", required: true },
      { key: "paperclipai/paperclip/optional", name: "optional", body: "# Optional", required: false },
    ]);
    cleanupRoot = root;

    const config = {
      paperclipRuntimeSkills: entries.map((e) => ({
        key: e.key,
        runtimeName: e.runtimeName,
        source: e.source,
        required: e.required,
      })),
      // No paperclipSkillSync — only required entries are auto-applied.
    };

    const result = await buildZaiSkillInjection(config);
    expect(result.injectedKeys).toContain("paperclipai/paperclip/required-one");
    expect(result.injectedKeys).not.toContain("paperclipai/paperclip/optional");
  });

  it("uses runtimeName in the injected section header", async () => {
    const { root, entries } = await makeSkillsTree([
      { key: "paperclipai/paperclip/comment-helper", name: "comment-helper", body: "Use this skill." },
    ]);
    cleanupRoot = root;
    const config = {
      paperclipRuntimeSkills: entries.map((e) => ({
        key: e.key,
        runtimeName: e.runtimeName,
        source: e.source,
        required: e.required,
      })),
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/comment-helper"],
      },
    };
    const result = await buildZaiSkillInjection(config);
    expect(result.systemPromptAddendum).toContain("### Skill: comment-helper");
  });
});
