import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gradeRepositoryBundles, inspectRepositoryBundle, isOwnedRepositoryRuntimeRoot, remoteRepositoryInspector } from "./repository-skill-evidence.js";

describe("repository runtime delivery evidence", () => {
  it("binds local and remote copies to the owned native session and rejects library or foreign paths", () => {
    const session = "54db6e46-cd6d-468e-8864-fd71658b355b";
    const digest = "09a8b6d19d867b102dcb01a222d2dde7d3cb0054031af0d73ed93f3c718516a7";
    const local = { kind: "local" as const, instanceRoot: "/owned/instance" };
    const localRoot = `/owned/instance/runtime/paperclip-runner/durable-sessions/${digest}/codex-home/skills/architect`;
    expect(isOwnedRepositoryRuntimeRoot(localRoot, session, local)).toBe(true);
    expect(isOwnedRepositoryRuntimeRoot(localRoot, "another-session", local)).toBe(false);
    expect(isOwnedRepositoryRuntimeRoot(localRoot, session, { ...local, instanceRoot: "/foreign/instance" })).toBe(false);
    expect(isOwnedRepositoryRuntimeRoot("/owned/instance/runtime-context-assets/bundles/digest", session, local)).toBe(false);
    const preparedRoot = "/owned/instance/runtime-context-assets/bundles/assigned-digest";
    const prepared = { ...local, contextSkills: { sessionId: session, roots: [preparedRoot] } };
    expect(isOwnedRepositoryRuntimeRoot(preparedRoot, session, prepared)).toBe(true);
    expect(isOwnedRepositoryRuntimeRoot(preparedRoot, "another-session", prepared)).toBe(false);
    expect(isOwnedRepositoryRuntimeRoot("/owned/instance/runtime-context-assets/bundles/unassigned", session, prepared)).toBe(false);
    expect(isOwnedRepositoryRuntimeRoot(preparedRoot, session, { ...prepared, instanceRoot: "/foreign/instance" })).toBe(false);
    expect(isOwnedRepositoryRuntimeRoot("/owned/instance/skills/library", session, { ...local, contextSkills: { sessionId: session, roots: ["/owned/instance/skills/library"] } })).toBe(false);
    const remote = { kind: "daytona" as const, remoteCwd: "/home/daytona/workspace" };
    const filesystem = `/home/daytona/workspace/.paperclip-runtime/paperclip-runner/sessions/${digest}/filesystem`;
    for (const root of [`${filesystem}/context/skills/0-digest`, `${filesystem}/codex-home/skills/architect`]) {
      expect(isOwnedRepositoryRuntimeRoot(root, session, remote)).toBe(true);
      expect(isOwnedRepositoryRuntimeRoot(root, "another-session", remote)).toBe(false);
      expect(isOwnedRepositoryRuntimeRoot(root, session, { ...remote, remoteCwd: "/foreign/workspace" })).toBe(false);
      expect(isOwnedRepositoryRuntimeRoot(`${root}/nested`, session, remote)).toBe(false);
      expect(isOwnedRepositoryRuntimeRoot(`${root}/../architect`, session, remote)).toBe(false);
    }
  });
  it("checks actual bytes, binary files and executable bits locally and with the sandbox inspector", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "repository-delivery-")));
    try {
      mkdirSync(path.join(root, ".paperclip-repository", "shared"), { recursive: true });
      writeFileSync(path.join(root, "SKILL.md"), "Read .paperclip-repository/skills/main/SKILL.md");
      const binary = path.join(root, ".paperclip-repository/shared/binary.dat");
      writeFileSync(binary, Buffer.from([0, 255, 128]));
      const script = path.join(root, ".paperclip-repository/shared/run.sh");
      writeFileSync(script, "#!/bin/sh\necho ready\n"); chmodSync(script, 0o755);
      const local = inspectRepositoryBundle(root);
      // Run the exact shell program sent to Daytona, without a fake SDK or fake filesystem.
      const remote = JSON.parse(execFileSync("sh", ["-c", remoteRepositoryInspector([root])], { encoding: "utf8" }));
      expect(remote).toEqual([local]);
      expect(local.files.find(file => file.path.endsWith("binary.dat"))?.sha).toBe("d90dae2bbeb97246b9570981c3eac7b6c403df7b");
      expect(gradeRepositoryBundles([local], local.files, ["main"]).every(check => check.passed)).toBe(true);
      writeFileSync(binary, Buffer.from([0, 255, 129]));
      expect(gradeRepositoryBundles([inspectRepositoryBundle(root)], local.files, ["main"]).at(-1)?.passed).toBe(false);
      writeFileSync(binary, Buffer.from([0, 255, 128])); chmodSync(script, 0o644);
      expect(gradeRepositoryBundles([inspectRepositoryBundle(root)], local.files, ["main"]).at(-1)?.passed).toBe(false);
      symlinkSync("/etc", path.join(root, ".paperclip-repository/escape"));
      expect(() => inspectRepositoryBundle(root)).toThrow("Non-regular repository file");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects a missing selection or duplicate runtime directory", () => {
    const bundle = { root: "/fixture/skills/main", wrapper: ".paperclip-repository/skills/main/SKILL.md", files: [] };
    expect(gradeRepositoryBundles([bundle, bundle], [], ["main", "other"]).filter(check => !check.passed).map(check => check.id))
      .toEqual(["two-distinct-runtime-packages", "canonical-main", "canonical-other"]);
  });
});
