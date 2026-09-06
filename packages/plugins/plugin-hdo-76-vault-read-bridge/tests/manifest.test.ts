import { describe, it } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import manifest from "../src/manifest.ts";

describe("manifest", () => {
  it("uses apiVersion 1", () => {
    strictEqual(manifest.apiVersion, 1);
  });

  it("declares a stable plugin id", () => {
    strictEqual(manifest.id, "paperclip.hdo-76-vault-read-bridge");
  });

  it("declares the vault root as access: read", () => {
    ok(manifest.localFolders, "expected localFolders");
    const vault = manifest.localFolders?.find((f) => f.folderKey === "vault-root");
    ok(vault, "expected vault-root folder");
    strictEqual(vault?.access, "read");
  });

  it("declares only read-side capabilities", () => {
    const FORBIDDEN = [
      "issues.create",
      "issues.update",
      "issue.comments.create",
      "issue.documents.write",
      "activity.log.write",
      "approvals.respond",
      "issue.interactions.respond",
      "issue.interactions.create",
    ];
    for (const capability of manifest.capabilities) {
      ok(!FORBIDDEN.includes(capability), `forbidden capability ${capability}`);
    }
  });

  it("declares the project detail Vault tab slot", () => {
    const tab = manifest.ui?.slots.find((s) => s.type === "detailTab");
    ok(tab, "expected detailTab slot");
    strictEqual(tab?.displayName, "Vault");
    deepStrictEqual(tab?.entityTypes, ["project"]);
  });

  it("declares the project sidebar item slot", () => {
    const sidebar = manifest.ui?.slots.find((s) => s.type === "projectSidebarItem");
    ok(sidebar, "expected projectSidebarItem slot");
    strictEqual(sidebar?.displayName, "Vault");
    deepStrictEqual(sidebar?.entityTypes, ["project"]);
  });
});

describe("package", () => {
  it("points paperclipPlugin entrypoints at dist/", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      paperclipPlugin: { manifest: string; worker: string; ui: string };
    };
    strictEqual(pkg.paperclipPlugin.manifest, "./dist/manifest.js");
    strictEqual(pkg.paperclipPlugin.worker, "./dist/worker.js");
    strictEqual(pkg.paperclipPlugin.ui, "./dist/ui/");
  });
});
