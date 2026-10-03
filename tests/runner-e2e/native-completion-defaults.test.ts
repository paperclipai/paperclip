import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { captureNativeDefault, gradeNativeDefault, nativeCompletionProfile, nativeCompletionWorkspaceDigest, NATIVE_MASTER_DEFAULT_SHA256, type NativeDefaultReceipt } from "./native-completion-defaults.js";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerProfileFixture } from "./types.js";
import { runnerSuites } from "./catalog.js";
import { contextIntegrityTasks } from "./context-integrity-cases.js";

const receipt = (): NativeDefaultReceipt => ({ schema: "paperclip.native-completion-default.v1", agentId: "agent", companyId: "company",
  entryFile: "AGENTS.md", files: [{ path: "AGENTS.md", sha256: NATIVE_MASTER_DEFAULT_SHA256, bytes: 100 }], budgets: { company: 1000, agent: 1000 } });
describe("native production defaults", () => {
  it("hashes scoped file and symlink identity without reading an outside target", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "native-workspace-calibration-"));
    try {
      const root = path.join(temporary, "workspace"), outside = path.join(temporary, "outside");
      await mkdir(root); await mkdir(outside);
      await writeFile(path.join(root, "file"), "initial"); await writeFile(path.join(outside, "private"), "first");
      await symlink(outside, path.join(root, "skill-link"));
      const first = await nativeCompletionWorkspaceDigest(root);
      await writeFile(path.join(outside, "private"), "changed outside");
      expect(await nativeCompletionWorkspaceDigest(root)).toBe(first);
      await writeFile(path.join(root, "file"), "changed fixture");
      expect(await nativeCompletionWorkspaceDigest(root)).not.toBe(first);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  it("preserves the original assigned-skill prompt flow and oracle in exactly six explicit cells", () => {
    const suite = runnerSuites.find(value => value.id === "native-completion")!;
    const original = contextIntegrityTasks.find(value => value.id === "assigned-skill-explicit-invocation")!;
    const completion = suite.tasks.find(value => value.id === original.id)!;
    expect({ ...completion, automaticRetryPolicy: undefined }).toEqual({ ...original, automaticRetryPolicy: undefined });
    expect(suite.manualOnly).toBe(true);
    expect(suite.expectedMatrixSize).toBe(6);
    expect(suite.tasks).toHaveLength(2);
    expect(suite.tasks.every(task => task.expectedRunCount === 1 && task.automaticRetryPolicy === "single_attempt")).toBe(true);
    expect(suite.environments.map(value => value.id)).toEqual(["local"]);
    expect(suite.profiles.map(value => value.id).sort()).toEqual(["runner-acpx-claude", "runner-codex", "runner-opencode"]);
  });
  it("accepts only the unchanged master default and bounded budgets", () => expect(gradeNativeDefault(receipt()).passed).toBe(true));
  it.each(["qa", "reduced", "extra-file", "wrong-entry", "company-unbounded", "agent-unbounded"])("rejects %s override", name => {
    const value = receipt();
    if (name === "qa" || name === "reduced") value.files[0]!.sha256 = name;
    if (name === "extra-file") value.files.push({ path: "HEARTBEAT.md", sha256: "x", bytes: 1 });
    if (name === "wrong-entry") value.entryFile = "OTHER.md";
    if (name === "company-unbounded") value.budgets.company = 0;
    if (name === "agent-unbounded") value.budgets.agent = 0;
    expect(gradeNativeDefault(value).passed).toBe(false);
  });
  it("strips only the fixture bundle and preserves auth skills permissions and model", () => {
    const original = { instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": "QA" } },
      adapterConfig: { model: "same", env: { KEY: { type: "secret_ref", secretId: "id" } } },
      runtimeConfig: { permissionMode: "same" }, skills: ["same"], budgetMonthlyCents: 0 };
    const profile = { generation: "native", buildAgent: () => original } as unknown as RunnerProfileFixture;
    const wrapped = nativeCompletionProfile(profile).buildAgent({} as never);
    expect(wrapped).toEqual({ ...original, instructionsBundle: undefined, budgetMonthlyCents: 1000 });
    expect(Object.hasOwn(wrapped, "instructionsBundle")).toBe(false);
    expect(original.instructionsBundle).toBeDefined();
    expect(() => nativeCompletionProfile({ ...profile, generation: "legacy" })).toThrow();
  });
  it("hashes actual public bundle bytes before execution without publishing the body", async () => {
    const content = readFileSync(new URL("../../server/src/onboarding-assets/default/AGENTS.md", import.meta.url), "utf8");
    const called: string[] = [];
    const api = { async get<T>(path: string): Promise<T> {
      called.push(path);
      return (path.endsWith("instructions-bundle") ? { entryFile: "AGENTS.md", files: [{ path: "AGENTS.md" }] }
        : path.includes("instructions-bundle/file") ? { content } : { budgetMonthlyCents: 1000 }) as T;
    } };
    const actual = await captureNativeDefault({ api, agentId: "agent", companyId: "company" });
    expect(gradeNativeDefault(actual).passed).toBe(true);
    expect(called).toContain("/api/agents/agent/instructions-bundle/file?path=AGENTS.md");
    expect(JSON.stringify(actual)).not.toContain(content);
  });
});
