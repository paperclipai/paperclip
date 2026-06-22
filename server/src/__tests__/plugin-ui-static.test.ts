import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePluginUiDir } from "../routes/plugin-ui-static.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-ui-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("resolvePluginUiDir", () => {
  it("resolves UI directories inside a persisted package path", () => {
    const root = createTempRoot();
    const packageRoot = path.join(root, "plugin");
    const uiDir = path.join(packageRoot, "dist", "ui");
    fs.mkdirSync(uiDir, { recursive: true });

    expect(resolvePluginUiDir(root, "paperclip-plugin-test", "./dist/ui", packageRoot)).toBe(uiDir);
  });

  it("rejects sibling-prefix traversal from a persisted package path", () => {
    const root = createTempRoot();
    const packageRoot = path.join(root, "plugin");
    const outsideUiDir = path.join(root, "plugin-evil", "ui");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.mkdirSync(outsideUiDir, { recursive: true });

    expect(resolvePluginUiDir(root, "paperclip-plugin-test", "../plugin-evil/ui", packageRoot)).toBeNull();
  });

  it("rejects traversal from a node_modules package root", () => {
    const root = createTempRoot();
    const packageRoot = path.join(root, "node_modules", "paperclip-plugin-test");
    const outsideUiDir = path.join(root, "secret", "ui");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.mkdirSync(outsideUiDir, { recursive: true });

    expect(resolvePluginUiDir(root, "paperclip-plugin-test", "../../secret/ui")).toBeNull();
  });

  it("rejects UI directory symlinks that resolve outside the package root", () => {
    const root = createTempRoot();
    const packageRoot = path.join(root, "plugin");
    const outsideUiDir = path.join(root, "outside-ui");
    const linkPath = path.join(packageRoot, "dist", "ui");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.mkdirSync(outsideUiDir, { recursive: true });
    fs.symlinkSync(outsideUiDir, linkPath, "dir");

    expect(resolvePluginUiDir(root, "paperclip-plugin-test", "./dist/ui", packageRoot)).toBeNull();
  });
});
