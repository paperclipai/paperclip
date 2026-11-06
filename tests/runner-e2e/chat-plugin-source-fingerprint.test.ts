import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { fingerprintChatDependencyClosure } from "./chat-catalog-fingerprint.js";
import { findChatCatalogCase, loadChatCatalogImplementation } from "./chat-catalog-registry.js";

const selected = ["plugins.configure-plugin", "plugins.disable-plugin", "plugins.install-plugin", "plugins.use-plugin-tool", "routines.plugin-managed-routine", "secrets.least-scope-delivery"];
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it.each(selected)("%s binds its actual source CLI, loader and required built SDK without unused CLI dist", async id => {
  const descriptor = findChatCatalogCase(id)!;
  const implementation = await loadChatCatalogImplementation(descriptor);
  expect(implementation.sourceFiles).toEqual(descriptor.sourceFiles);
  expect(descriptor.sourceFiles).toEqual(expect.arrayContaining(["../../cli/src/index.ts", "../../cli/node_modules/tsx/dist/loader.mjs", "../../packages/plugins/sdk/dist/index.js"]));
  expect(descriptor.sourceFiles).not.toContain("../../cli/dist/index.js");
});

it("resolves and hashes the actual executed source CLI and loader dependency closure without running either", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const entries = ["cli/src/index.ts", "cli/node_modules/tsx/dist/loader.mjs"];
  const fingerprint = fingerprintChatDependencyClosure({ root, entries, selected: { fixture: "source-cli" } });
  for (const file of [...entries, "cli/src/commands/client/plugin.ts"]) {
    expect(fingerprint.sources).toContainEqual({ file, sha256: createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex") });
  }
});

it("still rejects missing actual source imports, the executed loader and required SDK artifact", () => {
  const root = mkdtempSync(path.join(tmpdir(), "plugin-source-closure-")); directories.push(root);
  mkdirSync(path.join(root, "cli/src"), { recursive: true });
  writeFileSync(path.join(root, "cli/src/index.ts"), 'export { command } from "./command.js";');
  const fingerprint = (entries: string[]) => fingerprintChatDependencyClosure({ root, entries, selected: {} });
  expect(() => fingerprint(["cli/src/index.ts"])).toThrow("Unresolved fingerprint dependency: ./command.js");
  writeFileSync(path.join(root, "cli/src/command.ts"), "export const command = 1;");
  expect(fingerprint(["cli/src/index.ts"]).sources.map(row => row.file)).toContain("cli/src/command.ts");
  expect(() => fingerprint(["cli/src/index.ts", "cli/node_modules/tsx/dist/loader.mjs"])).toThrow("Unresolved fingerprint dependency");
  expect(() => fingerprint(["cli/src/index.ts", "packages/plugins/sdk/dist/index.js"])).toThrow("Unresolved fingerprint dependency");
});
