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

it("stages assigned skills under the runtime name the provider can load", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-skill-runtime-name-"));
  const skillsHome = join(root, "home");
  try {
    const review = join(root, "review");
    const plain = join(root, "plain");
    await Promise.all([mkdir(review), mkdir(plain)]);
    const reviewMarkdown = "---\nname: review\ndescription: Review work\n---\n# Review\n";
    await writeFile(join(review, "SKILL.md"), reviewMarkdown);
    await writeFile(join(plain, "SKILL.md"), "# Plain\n");
    const context = {
      prompt: { revision: "test", text: "Test", digest },
      instructions: { entryPath: "AGENTS.md", bundle: asset(root) },
      skills: [
        { key: "company/review", runtimeName: "review--abc123", versionId: null, bundle: asset(review) },
        { key: "company/plain", runtimeName: "plain", versionId: null, bundle: asset(plain) },
      ],
      mcp: { assignmentSetId: "none", digest, bindingId: null },
      aggregateDigest: digest,
    } as unknown as NativeRuntimeContextSnapshot;

    await materializeNativeRuntimeSkills(context, skillsHome);

    // The provider indexes the top-level name, so the granted runtime name must
    // be present; the source document and the no-frontmatter control stay intact.
    await expect(readFile(join(skillsHome, "review--abc123", "SKILL.md"), "utf8"))
      .resolves.toBe(reviewMarkdown.replace("name: review\n", "name: review--abc123\n"));
    await expect(readFile(join(skillsHome, "plain", "SKILL.md"), "utf8"))
      .resolves.toBe("# Plain\n");
    await expect(readFile(join(review, "SKILL.md"), "utf8")).resolves.toBe(reviewMarkdown);
  } finally {
    await releaseMaterializedNativeRuntimeSkills(skillsHome).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});