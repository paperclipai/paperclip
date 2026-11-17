import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalNativeRuntimeContextDigest, nativeRuntimeContextAssets, parseNativeRuntimeContext, type NativeRuntimeContextSnapshot } from "./runtime-context.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const asset = (name: string) => ({ schema: "paperclip.runtime-asset.v1" as const, digest: hash(name), manifestDigest: hash(name), rootPath: `/assets/${name}`, fileCount: 1, totalBytes: 42 });
function fixture(): NativeRuntimeContextSnapshot {
  const repository = { bundle: asset("repository"), entryPath: "skills/één/SKILL.md", policyPath: "skills/één/agents/openai.yaml" };
  const context = {
    prompt: { revision: "saved", text: "saved prompt", digest: hash("saved prompt") },
    instructions: { entryPath: "AGENTS.md", bundle: asset("instructions") },
    skills: ["one", "two"].map((key) => ({ key, runtimeName: key, versionId: key, bundle: asset(key), repository })),
    mcp: { assignmentSetId: "none", digest: hash("mcp"), bindingId: null },
  };
  return { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) };
}

describe("shared skill repository contract", () => {
  it("roundtrips two entrypoints with one unique repository asset", () => {
    const context = fixture();
    expect(parseNativeRuntimeContext(context)).toEqual(context);
    expect(nativeRuntimeContextAssets(context).map((entry) => entry.digest)).toEqual([
      asset("instructions").digest, asset("one").digest, asset("repository").digest, asset("two").digest,
    ]);
  });
  it.each(["entryPath", "policyPath", "bundle"])("pins repository %s in the canonical digest", (field) => {
    const context = fixture();
    const changed = structuredClone(context);
    Object.assign(changed.skills[0]!.repository!, { [field]: field === "bundle" ? asset("other") : "other/SKILL.md" });
    expect(canonicalNativeRuntimeContextDigest(changed)).not.toBe(context.aggregateDigest);
    expect(() => parseNativeRuntimeContext({ ...changed, aggregateDigest: context.aggregateDigest })).toThrow("aggregateDigest");
  });
  it.each(["../secret", "/absolute", "C:/absolute", "a/../secret", "a//b", "a\u0000b"])("rejects an unsafe repository entrypoint %s", (entryPath) => {
    const context = fixture();
    context.skills[0]!.repository!.entryPath = entryPath;
    expect(() => parseNativeRuntimeContext(context)).toThrow("bundle root");
  });
  it("rejects unknown repository fields and conflicting metadata for a shared digest", () => {
    const context = fixture();
    expect(() => parseNativeRuntimeContext({ ...context, skills: [{ ...context.skills[0], repository: { ...context.skills[0]!.repository, extra: true } }] })).toThrow("unknown field");
    context.skills[1]!.repository = { ...context.skills[1]!.repository!, bundle: { ...asset("repository"), totalBytes: 100 } };
    expect(() => nativeRuntimeContextAssets(context)).toThrow("conflicting");
  });
});
