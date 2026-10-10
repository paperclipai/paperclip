import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import { bindAcpxAgentFiles } from "./agent-files-binding.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "acpx-agent-files-"));
  roots.push(parent);
  const root = join(parent, "registered-run-copy");
  const protectedRoot = join(parent, "provider-state");
  mkdirSync(root); mkdirSync(protectedRoot);
  const context = { instructions: { workingCopy: { kind: "agent_files", rootPath: root, entryPath: "AGENTS.md" } } } as NativeRuntimeContextSnapshot;
  return { parent, root, protectedRoot, context };
}

describe("registered ACP agent files", () => {
  it("binds a persistent computer home without inventing an instruction copy", () => {
    const { root, parent, context } = fixture();
    delete context.instructions.workingCopy;
    context.persistentAgentHome = { rootPath: root };
    const nestedRuntime = join(root, ".paperclip-runtime"); mkdirSync(nestedRuntime);
    const binding = bindAcpxAgentFiles(context, [nestedRuntime])!;
    expect(binding.root.endsWith("registered-run-copy")).toBe(true);
    for (const protectedRoot of [parent, root]) {
      expect(() => bindAcpxAgentFiles(context, [protectedRoot])).toThrow("overlaps");
    }
    renameSync(root, `${root}-old`); mkdirSync(root);
    expect(() => binding.assertHeld()).toThrow("changed");
  });
  it("does not grant absent or legacy instruction copies", () => {
    expect(bindAcpxAgentFiles(null, [])).toBeNull();
    const { context } = fixture();
    delete context.instructions.workingCopy!.kind;
    expect(bindAcpxAgentFiles(context, [])).toBeNull();
  });
  it("binds only the registered copy and detects replaced roots", () => {
    const { root, context, protectedRoot } = fixture();
    const binding = bindAcpxAgentFiles(context, [protectedRoot])!;
    expect(binding.root.endsWith("/registered-run-copy")).toBe(true);
    expect(() => binding.assertHeld()).not.toThrow();
    renameSync(root, `${root}-old`); mkdirSync(root);
    expect(() => binding.assertHeld()).toThrow("changed");
  });
  it("rejects symlink roots and symlink replacement", () => {
    const { root, context, protectedRoot } = fixture();
    const binding = bindAcpxAgentFiles(context, [])!;
    renameSync(root, `${root}-old`); symlinkSync(protectedRoot, root);
    expect(() => binding.assertHeld()).toThrow("changed");
    expect(() => bindAcpxAgentFiles(context, [])).toThrow("real directory");
  });
  it("rejects both directions of protected-root overlap", () => {
    const { parent, root, context } = fixture();
    const child = join(root, "nested-runtime"); mkdirSync(child);
    for (const protectedRoot of [parent, root, child]) {
      expect(() => bindAcpxAgentFiles(context, [protectedRoot])).toThrow("overlaps");
    }
  });
  it("rejects relative, non-normalized and filesystem-root grants", () => {
    const { context } = fixture();
    for (const rootPath of ["relative", "/tmp/../tmp", "/", "/tmp\0invalid"]) {
      context.instructions.workingCopy!.rootPath = rootPath;
      expect(() => bindAcpxAgentFiles(context, [])).toThrow();
    }
  });
});
