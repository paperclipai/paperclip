import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloudBundledPackageDigest } from "../services/cloud-bundled-package-digest.js";

const roots: string[] = [];
function file(name: string, content = "export const value = 1;") {
  fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, content);
}
function link(target: string, name: string) {
  fs.mkdirSync(path.dirname(name), { recursive: true }); fs.symlinkSync(path.relative(path.dirname(name), target), name);
}
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "image-package-graph-"))); roots.push(root);
  const catalogRoot = path.join(root, "packages", "plugins");
  const provider = path.join(catalogRoot, "sandbox-providers", "daytona");
  const sdk = path.join(catalogRoot, "sdk");
  const shared = path.join(root, "packages", "shared");
  const dependency = path.join(root, "node_modules", ".pnpm", "dependency@1", "node_modules", "dependency");
  const transitive = path.join(root, "node_modules", ".pnpm", "transitive@1", "node_modules", "transitive");
  for (const directory of [provider, sdk, shared, dependency, transitive]) file(path.join(directory, "index.js"));
  link(sdk, path.join(provider, "node_modules", "@paperclipai", "plugin-sdk"));
  link(shared, path.join(sdk, "node_modules", "@paperclipai", "shared"));
  link(dependency, path.join(shared, "node_modules", "dependency"));
  link(transitive, path.join(path.dirname(dependency), "transitive"));
  return { root, catalogRoot, provider, sdk, shared, dependency, transitive };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("bounded current-image package dependency inventory", () => {
  it("hashes external SDK, shared, and pnpm sibling dependency bytes", () => {
    const image = fixture();
    const digest = () => cloudBundledPackageDigest(image.provider, { catalogRoot: image.catalogRoot });
    let previous = digest();
    for (const directory of [image.sdk, image.shared, image.dependency, image.transitive]) {
      file(path.join(directory, "index.js"), "export const value = 2;");
      const next = digest(); expect(next).not.toBe(previous); previous = next;
    }
  });

  it("keeps the digest stable when an identical release moves to a new root", () => {
    const original = fixture(); const replacement = fixture();
    expect(cloudBundledPackageDigest(original.provider, { catalogRoot: original.catalogRoot }))
      .toBe(cloudBundledPackageDigest(replacement.provider, { catalogRoot: replacement.catalogRoot }));
  });

  it("rejects legacy-home links and preserves package-contained defaults", () => {
    const image = fixture();
    expect(() => cloudBundledPackageDigest(image.provider)).toThrow("escapes its package");
    const outside = fixture();
    link(path.join(outside.sdk, "index.js"), path.join(image.shared, "legacy-home.js"));
    expect(() => cloudBundledPackageDigest(image.provider, { catalogRoot: image.catalogRoot })).toThrow("authorized image roots");
  });

  it("deduplicates cycles without scanning unrelated image node_modules", () => {
    const image = fixture();
    link(image.sdk, path.join(image.shared, "node_modules", "cycle"));
    const unrelated = path.join(image.root, "node_modules", "unrelated", "special");
    file(unrelated);
    const first = cloudBundledPackageDigest(image.provider, { catalogRoot: image.catalogRoot });
    file(unrelated, "changed unrelated code");
    expect(cloudBundledPackageDigest(image.provider, { catalogRoot: image.catalogRoot })).toBe(first);
  });

  it.each(["", ".pnpm", ".pnpm/node_modules"])("rejects aggregate image dependency targets: %s", (aggregate) => {
    const image = fixture();
    const target = path.join(image.root, "node_modules", aggregate);
    fs.mkdirSync(target, { recursive: true });
    link(target, path.join(image.sdk, "node_modules", "aggregate"));
    expect(() => cloudBundledPackageDigest(image.provider, { catalogRoot: image.catalogRoot })).toThrow("select an individual package");
  });

  it("accepts the shipped provider's observed entry class", () => {
    const image = fixture();
    const directory = path.join(image.provider, "many"); fs.mkdirSync(directory);
    for (let index = 0; index < 16_000; index++) fs.writeFileSync(path.join(directory, `${index}.js`), "");
    expect(cloudBundledPackageDigest(image.provider, { catalogRoot: image.catalogRoot })).toMatch(/^sha256:/);
  });

  it("rejects oversized metadata and excessive depth", () => {
    const image = fixture();
    file(path.join(image.sdk, "package.json"), " ".repeat(128 * 1024 + 1));
    expect(() => cloudBundledPackageDigest(image.provider, { catalogRoot: image.catalogRoot })).toThrow("metadata");
    fs.rmSync(path.join(image.sdk, "package.json"));
    const large = path.join(image.shared, "large.js");
    fs.closeSync(fs.openSync(large, "w")); fs.truncateSync(large, 256 * 1024 * 1024 + 1);
    expect(() => cloudBundledPackageDigest(image.provider, { catalogRoot: image.catalogRoot })).toThrow("byte limit");
    fs.rmSync(large);
    file(path.join(image.sdk, ...Array.from({ length: 33 }, () => "deep"), "file.js"));
    expect(() => cloudBundledPackageDigest(image.provider, { catalogRoot: image.catalogRoot })).toThrow("depth limit");
  });
});
