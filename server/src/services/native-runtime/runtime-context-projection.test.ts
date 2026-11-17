import { describe, expect, it } from "vitest";
import { canonicalNativeRuntimeContextDigest, nativeRuntimeContextAssets } from "../../vendor/paperclip-runner/index.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { projectNativeRuntimeContextForRunner } from "./runtime-context-projection.js";

describe("remote runtime asset roots", () => {
  it("maps two repository references to one provider-owned root without changing pinned identity", () => {
    const context = nativeRuntimeContextFixture();
    const repository = { ...context.instructions.bundle, digest: "1".repeat(64), manifestDigest: "2".repeat(64), rootPath: "C:\\private\\repository" };
    context.skills = ["one", "two"].map((name, index) => ({ key: name, runtimeName: name, versionId: name,
      bundle: { ...context.instructions.bundle, digest: String(index + 3).repeat(64), rootPath: `C:\\private\\${name}` },
      repository: { bundle: repository, entryPath: `skills/${name}/SKILL.md`, policyPath: null } }));
    context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
    const mapped = projectNativeRuntimeContextForRunner(context, "/guest/filesystem");
    expect(nativeRuntimeContextAssets(mapped)).toHaveLength(4);
    expect(mapped.skills[0]!.repository!.bundle.rootPath).toBe(`/guest/filesystem/codex-home/repositories/${repository.digest}`);
    expect(mapped.skills[1]!.repository!.bundle.rootPath).toBe(mapped.skills[0]!.repository!.bundle.rootPath);
    expect(nativeRuntimeContextAssets(mapped).every(asset => asset.rootPath.startsWith("/guest/filesystem/"))).toBe(true);
    expect(canonicalNativeRuntimeContextDigest(mapped)).toBe(context.aggregateDigest);
    expect(context.skills[0]!.repository!.bundle.rootPath).toBe("C:\\private\\repository");
  });
  it("keeps the previous portable transport layout for saved contexts", () => {
    const old = nativeRuntimeContextFixture();
    old.skills = [{ key: "one", runtimeName: "one", versionId: "saved-version", bundle: old.instructions.bundle }];
    const mapped = projectNativeRuntimeContextForRunner(old, "/guest/filesystem");
    expect(mapped.instructions.bundle.rootPath).toBe("/guest/filesystem/context/instructions");
    expect(mapped.skills[0]!.bundle.rootPath).toBe("/guest/filesystem/context/skills/0-000000000000");
    expect(mapped.aggregateDigest).toBe(old.aggregateDigest);
    expect(mapped.skills[0]).not.toHaveProperty("repository");
  });
});
