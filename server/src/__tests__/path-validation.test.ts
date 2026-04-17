import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveWithinRoot } from "../home-paths.js";

describe("resolveWithinRoot", () => {
  it("allows paths within the root directory", () => {
    const root = "/workspace/project";
    const result = resolveWithinRoot("/workspace/project/src/index.ts", root);
    expect(result).toBe(path.resolve("/workspace/project/src/index.ts"));
  });

  it("allows the root directory itself", () => {
    const root = "/workspace/project";
    const result = resolveWithinRoot("/workspace/project", root);
    expect(result).toBe(path.resolve("/workspace/project"));
  });

  it("blocks path traversal with ..", () => {
    const root = "/workspace/project";
    expect(() => {
      resolveWithinRoot("/workspace/project/../../../etc/passwd", root);
    }).toThrow(/resolves outside allowed root/);
  });

  it("blocks path traversal via relative ..", () => {
    const root = "/workspace/project";
    expect(() => {
      resolveWithinRoot("../../etc/passwd", root);
    }).toThrow(/resolves outside allowed root/);
  });

  it("blocks sibling directory access", () => {
    const root = "/workspace/project";
    expect(() => {
      resolveWithinRoot("/workspace/other-project/secrets", root);
    }).toThrow(/resolves outside allowed root/);
  });

  it("blocks root prefix matching without path separator", () => {
    // /workspace/project-evil should NOT match /workspace/project
    const root = "/workspace/project";
    expect(() => {
      resolveWithinRoot("/workspace/project-evil/file.txt", root);
    }).toThrow(/resolves outside allowed root/);
  });

  it("allows deeply nested paths within root", () => {
    const root = "/workspace/project";
    const result = resolveWithinRoot("/workspace/project/a/b/c/d/file.txt", root);
    expect(result).toBe(path.resolve("/workspace/project/a/b/c/d/file.txt"));
  });
});
