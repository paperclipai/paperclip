import { resolve } from "node:path";
import { expect, it } from "vitest";
import { nativeTaskSkillInputs } from "../backends/runtime-context.js";
import { mapNativeRuntimeContextAssetRoots } from "../contracts/runtime-context.js";
import { assignedRuntimeContext } from "../../test/support/runnerd-transport.js";
import { resolveRunnerdCodexSkillInputs } from "./runnerd-codex-transport.js";

it.each(["assigned", "nested/één"])("transports the original shared entrypoint for %s", name => {
  const context = assignedRuntimeContext("/controller/discovery", "/controller/instructions");
  const skill = context.skills[0]!;
  skill.runtimeName = name;
  skill.repository = { bundle: { ...skill.bundle, digest: "1".repeat(64), rootPath: "/controller/repository" }, entryPath: "skills/original/SKILL.md", policyPath: null };
  const inputs = nativeTaskSkillInputs(`Use $${name}`, context);
  expect(inputs).toHaveLength(1);
  expect(resolveRunnerdCodexSkillInputs(inputs, context, "/provider/home")).toEqual([
    { type: "skill", name, path: resolve("/provider/home/repositories", skill.repository.bundle.digest, skill.repository.entryPath) },
  ]);
  const prepared = mapNativeRuntimeContextAssetRoots(context, asset => `/guest/${asset.digest}`);
  expect(resolveRunnerdCodexSkillInputs(inputs, context, "/unused", prepared)).toEqual([
    { type: "skill", name, path: resolve("/guest", skill.repository.bundle.digest, skill.repository.entryPath) },
  ]);
  for (const input of [{ ...inputs[0], path: resolve(skill.bundle.rootPath, "SKILL.md") }, { ...inputs[0], path: "/unassigned/SKILL.md" }]) {
    expect(() => resolveRunnerdCodexSkillInputs([input], context, "/provider/home")).toThrow("unique assigned runtime skill");
  }
});
