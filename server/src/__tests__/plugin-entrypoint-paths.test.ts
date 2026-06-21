import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSafePackageRelativeEntrypoint,
  resolveExistingPackageEntrypoint,
} from "../services/plugin-entrypoint-paths.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-entrypoints-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("plugin entrypoint path helpers", () => {
  it("accepts package-relative entrypoints", () => {
    expect(isSafePackageRelativeEntrypoint("./dist/worker.js")).toBe(true);
    expect(isSafePackageRelativeEntrypoint("dist/ui")).toBe(true);
  });

  it.each([
    "../dist/worker.js",
    "dist/../../worker.js",
    "/tmp/worker.js",
    "C:\\tmp\\worker.js",
    "https://example.com/worker.js",
  ])("rejects unsafe entrypoint path %s", (entrypoint) => {
    expect(isSafePackageRelativeEntrypoint(entrypoint)).toBe(false);
  });

  it("resolves existing files inside the package root", () => {
    const root = createTempRoot();
    const packageRoot = path.join(root, "plugin");
    const worker = path.join(packageRoot, "dist", "worker.js");
    fs.mkdirSync(path.dirname(worker), { recursive: true });
    fs.writeFileSync(worker, "export {};\n", "utf8");

    expect(resolveExistingPackageEntrypoint(packageRoot, "./dist/worker.js", "file")).toBe(worker);
  });

  it("rejects sibling-prefix traversal outside the package root", () => {
    const root = createTempRoot();
    const packageRoot = path.join(root, "plugin");
    const outsideWorker = path.join(root, "plugin-evil", "worker.js");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.mkdirSync(path.dirname(outsideWorker), { recursive: true });
    fs.writeFileSync(outsideWorker, "export {};\n", "utf8");

    expect(resolveExistingPackageEntrypoint(packageRoot, "../plugin-evil/worker.js", "file")).toBeNull();
  });

  it("rejects symlinks that resolve outside the package root", () => {
    const root = createTempRoot();
    const packageRoot = path.join(root, "plugin");
    const outsideWorker = path.join(root, "outside", "worker.js");
    const linkPath = path.join(packageRoot, "dist", "worker.js");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.mkdirSync(path.dirname(outsideWorker), { recursive: true });
    fs.writeFileSync(outsideWorker, "export {};\n", "utf8");
    fs.symlinkSync(outsideWorker, linkPath);

    expect(resolveExistingPackageEntrypoint(packageRoot, "./dist/worker.js", "file")).toBeNull();
  });
});
