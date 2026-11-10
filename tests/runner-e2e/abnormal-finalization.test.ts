import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { abnormalFinalizationResult } from "./abnormal-finalization.js";
import type { RunnerE2EResult } from "./types.js";
it("retains a real failed child stderr and secondary packaging error as one failed measurement", () => {
  const child = spawnSync(process.execPath, ["-e", 'process.stderr.write("owned offline bootstrap failed\\n");process.exit(1)'], { encoding: "utf8" });
  expect(child.status).toBe(1);
  const original = { schema: "paperclip.runner-e2e.result/v2", executionId: "chat-features.fixture.local.example", source: { sha: "a".repeat(40) },
    status: "failed", failureClass: "transient_infrastructure", error: child.stderr.trim(), cleanup: "not_started", attempt: 1 } as RunnerE2EResult;
  const result = abnormalFinalizationResult(original, new SyntaxError("reporter JSON parse failed"));
  expect(result).toMatchObject({ status: "failed", failureClass: "transient_infrastructure", cleanup: "not_started", attempt: 1, source: original.source });
  expect(result.error).toContain("owned offline bootstrap failed"); expect(result.error).toContain("reporter JSON parse failed");
  expect(original.error).not.toContain("reporter JSON");
});
it("never turns a valid cleanup receipt into successful behavior after packaging fails", () => {
  const original = { schema: "paperclip.runner-e2e.result/v2", executionId: "fixture", attempt: 1, profileId: "fixture", environmentId: "local", caseId: "fixture", provider: null, model: null, runtimeMode: "none", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0, status: "passed", cleanup: "passed" } satisfies RunnerE2EResult;
  expect(abnormalFinalizationResult(original, new Error("artifact write failed"))).toMatchObject({ status: "failed", cleanup: "passed", failureClass: "permanent_infrastructure" });
});
