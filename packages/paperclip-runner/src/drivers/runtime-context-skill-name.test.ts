import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  type NativeRuntimeContextSnapshot,
} from "../contracts/runtime-context.js";
import {
  materializeNativeRuntimeSkills,
  releaseMaterializedNativeRuntimeSkills,
} from "./runtime-context-materializer.js";

const digest = "0".repeat(64);
const asset = (rootPath: string) => ({
  schema: NATIVE_RUNTIME_ASSET_SCHEMA,
  digest,
  manifestDigest: digest,
  rootPath,
  fileCount: 1,
  totalBytes: 1,
});

it.each([
  ["indented root", "---\n  name: |-\n    review\n  description: Review work\n  metadata:\n    name: nested\n---\n# Review\n", "---\n  name: review--abc123\n  description: Review work\n  metadata:\n    name: nested\n---\n# Review\n"],
  ["nested name first", "---\nmetadata:\n  name: nested\nname: review\ndescription: Review work\n---\n# Review\n", "---\nmetadata:\n  name: nested\nname: review--abc123\ndescription: Review work\n---\n# Review\n"],
  ["LF", "---\nname: review\ndescription: Review work\n---\n# Review\n", "---\nname: review--abc123\ndescription: Review work\n---\n# Review\n"],
  ["CRLF", "---\r\nname: review\r\ndescription: Review work\r\n---\r\n# Review\r\n", "---\r\nname: review--abc123\r\ndescription: Review work\r\n---\r\n# Review\r\n"],
  ["literal name", "---\nname: |-\n  review\ndescription: Review work\n---\n# Review\n", "---\nname: review--abc123\ndescription: Review work\n---\n# Review\n"],
  ["folded name", "---\nname: >-\n  review\ndescription: Review work\n---\n# Review\n", "---\nname: review--abc123\ndescription: Review work\n---\n# Review\n"],
])("stages the granted name with %s frontmatter", async (_label, reviewMarkdown, stagedMarkdown) => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-skill-runtime-name-"));
  const skillsHome = join(root, "home");
  try {
    const review = join(root, "review");
    const plain = join(root, "plain");
    const bundled = join(root, "bundled");
    await Promise.all([mkdir(review), mkdir(plain), mkdir(bundled)]);
    await writeFile(join(review, "SKILL.md"), reviewMarkdown);
    await writeFile(join(plain, "SKILL.md"), "# Plain\n");
    const bundledMarkdown = "---\nname: bundled\ndescription: Built in\nmetadata:\n  name: original\n---\n# Bundled\n";
    await writeFile(join(bundled, "SKILL.md"), bundledMarkdown);
    const context = {
      prompt: { revision: "test", text: "Test", digest },
      instructions: { entryPath: "AGENTS.md", bundle: asset(root) },
      skills: [
        { key: "company/review", runtimeName: "review--abc123", versionId: null, bundle: asset(review) },
        { key: "paperclipai/paperclip/bundled", runtimeName: "bundled", versionId: null, bundle: asset(bundled) },
        { key: "company/plain", runtimeName: "plain", versionId: null, bundle: asset(plain) },
      ],
      mcp: { assignmentSetId: "none", digest, bindingId: null },
      aggregateDigest: digest,
    } as unknown as NativeRuntimeContextSnapshot;

    await materializeNativeRuntimeSkills(context, skillsHome);

    await expect(readFile(join(skillsHome, "review--abc123", "SKILL.md"), "utf8"))
      .resolves.toBe(stagedMarkdown);
    await expect(readFile(join(skillsHome, "plain", "SKILL.md"), "utf8"))
      .resolves.toBe("# Plain\n");
    await expect(readFile(join(skillsHome, "bundled", "SKILL.md"), "utf8")).resolves.toBe(bundledMarkdown);
    await expect(readFile(join(review, "SKILL.md"), "utf8")).resolves.toBe(reviewMarkdown);
  } finally {
    await releaseMaterializedNativeRuntimeSkills(skillsHome).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
