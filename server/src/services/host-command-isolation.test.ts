import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runWorkspaceJobForControl } from "./workspace-runtime.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("refuses a host workspace job before its shell command runs in key isolation mode", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".paperclip-host-command-test-"));
  roots.push(root);
  const marker = path.join(root, "executed");
  vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
  await expect(runWorkspaceJobForControl({
    actor: { id: "synthetic-agent", name: "Synthetic", companyId: "synthetic-company" },
    issue: null,
    workspace: { cwd: root, baseCwd: root } as never,
    command: { name: "synthetic-host-job", command: `touch ${marker}` },
  })).rejects.toThrow(/forbid host workspace commands/);
  expect(existsSync(marker)).toBe(false);
});
