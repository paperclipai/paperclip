import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDshProviderPackages, createDshPackageJsonResolver, dshEntryPackageLinks } from "./dsh-installation.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { createAcpxPrivateSnapshot } from "./private-snapshot.js";

describe("DSH provider package closure", () => {
  it("skips only an optional package's own absence and rejects nested required failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-package-closure-"));
    const manifests = new Map<string, string>();
    const add = async (name: string, metadata: Record<string, unknown>) => {
      const directory = join(root, ...name.split("/"));
      await mkdir(directory, { recursive: true });
      const path = join(directory, "package.json");
      await writeFile(path, JSON.stringify({ name, ...metadata }));
      manifests.set(name, path);
    };
    try {
      await add("@deepseek-ai/dsh", { version: "0.2.1-rc.5" });
      await add("@deepseek-ai/dsh-app-boot", { version: "0.2.1-rc.5", dependencies: { "required-peer": "1" }, optionalDependencies: { "optional-b": "1" }, peerDependencies: { "required-peer": "1" }, peerDependenciesMeta: { "required-peer": { optional: true } } });
      await add("@deepseek-ai/dsh-acp-app", { version: "0.2.1-rc.5" });
      await add("@deepseek-ai/dsh-base", { version: "0.2.1-rc.5" });
      await add("optional-b", { version: "1", dependencies: { "required-c": "1" } });
      const profile = resolveQualifiedAcpxProfile("dsh", "deepseek-v4-flash");
      const resolve = (name: string): string => {
        const path = manifests.get(name);
        if (!path) throw Object.assign(new Error(`missing ${name}`), { code: "MODULE_NOT_FOUND" });
        return path;
      };
      const input = { profile, resolvePackageJson: resolve, serverPackageJsonPath: manifests.get("@deepseek-ai/dsh-app-boot")! };
      await expect(collectDshProviderPackages(input)).rejects.toThrow("missing required-c");

      manifests.delete("optional-b");
      await expect(collectDshProviderPackages(input)).rejects.toThrow("missing required-peer");
      await add("required-peer", { version: "1" });
      const closure = await collectDshProviderPackages(input);
      expect(closure.packages.map(entry => entry.directory)).not.toContain(join(root, "optional-b"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("resolves real package files asynchronously inside the selected root", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-package-async-"));
    try {
      await mkdir(join(root, "node_modules"), { recursive: true });
      await mkdir(join(root, "node_modules", "@deepseek-ai/dsh"), { recursive: true });
      await mkdir(join(root, "node_modules", "@deepseek-ai/dsh-app-boot"), { recursive: true });
      await mkdir(join(root, "node_modules", "@deepseek-ai/dsh-acp-app"), { recursive: true });
      await mkdir(join(root, "node_modules", "@deepseek-ai/dsh-base"), { recursive: true });
      await mkdir(join(root, "node_modules", "pkg-a"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
      await writeFile(join(root, "node_modules", "@deepseek-ai/dsh/package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.5" }));
      await writeFile(join(root, "node_modules", "@deepseek-ai/dsh-app-boot/package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", version: "0.2.1-rc.5", dependencies: { "pkg-a": "1" } }));
      await writeFile(join(root, "node_modules", "@deepseek-ai/dsh-acp-app/package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-acp-app", version: "0.2.1-rc.5" }));
      await writeFile(join(root, "node_modules", "@deepseek-ai/dsh-base/package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-base", version: "0.2.1-rc.5" }));
      await writeFile(join(root, "node_modules", "pkg-a/package.json"), JSON.stringify({ name: "pkg-a", version: "1" }));
      const profile = resolveQualifiedAcpxProfile("dsh", "deepseek-v4-flash");
      const closure = await collectDshProviderPackages({
        profile,
        resolvePackageJson: createDshPackageJsonResolver(root),
        serverPackageJsonPath: join(root, "package.json"),
      });
      expect(closure.packages).toHaveLength(5);
      const app = closure.packages.find(entry => entry.directory.endsWith("dsh-app-boot"))!.directory;
      const dependency = closure.packages.find(entry => entry.directory.endsWith("pkg-a"))!.directory;
      expect(closure.links.get(app)?.get("pkg-a")).toBe(dependency);
      await writeFile(join(root, "node_modules", "@deepseek-ai/dsh-app-boot/package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", version: "0.2.1-rc.5", dependencies: { "../outside": "1" } }));
      await expect(collectDshProviderPackages({ profile, resolvePackageJson: createDshPackageJsonResolver(root), serverPackageJsonPath: join(root, "package.json") })).rejects.toThrow("Invalid DSH package name");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves the runtime peer context through the actual snapshot links", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-peer-context-"));
    try {
      const add = async (directory: string, name: string, metadata: Record<string, unknown>) => {
        await mkdir(directory, { recursive: true });
        const manifest = join(directory, "package.json");
        await writeFile(manifest, JSON.stringify({ name, ...metadata }));
        return manifest;
      };
      const runtimeDir = join(root, "runtime"), appDir = join(root, "app"), acpDir = join(root, "acp"), baseDir = join(root, "base");
      const toolA = join(root, "tool-a"), toolB = join(root, "tool-b");
      const runtime = await add(runtimeDir, "@deepseek-ai/dsh", { version: "0.2.1-rc.5", dependencies: { tool: "1" } });
      const app = await add(appDir, "@deepseek-ai/dsh-app-boot", { version: "0.2.1-rc.5", dependencies: { tool: "1" } });
      await add(acpDir, "@deepseek-ai/dsh-acp-app", { version: "0.2.1-rc.5", dependencies: { tool: "1" } });
      await add(baseDir, "@deepseek-ai/dsh-base", { version: "0.2.1-rc.5" });
      const toolAPath = await add(toolA, "tool", { version: "1", variant: "app" });
      const toolBPath = await add(toolB, "tool", { version: "1", variant: "runtime" });
      const manifests = new Map([["@deepseek-ai/dsh", runtime], ["@deepseek-ai/dsh-app-boot", app], ["@deepseek-ai/dsh-acp-app", join(acpDir, "package.json")], ["@deepseek-ai/dsh-base", join(baseDir, "package.json")]]);
      const profile = resolveQualifiedAcpxProfile("dsh", "deepseek-v4-flash");
      const runtimeReal = await realpath(runtime), appReal = await realpath(app), acpReal = await realpath(join(acpDir, "package.json"));
      const closure = await collectDshProviderPackages({
        profile,
        serverPackageJsonPath: runtime,
        resolvePackageJson: (name, issuer) => {
          if (name === "tool") {
            if (issuer === appReal) return toolAPath;
            if (issuer === runtimeReal || issuer === acpReal) return toolBPath;
          }
          const path = manifests.get(name);
          if (!path) throw Object.assign(new Error(`missing ${name}`), { code: "MODULE_NOT_FOUND" });
          return path;
        },
      });
      const entryLinks = dshEntryPackageLinks(closure.packages, await realpath(runtimeDir), closure.links.get(await realpath(runtimeDir)));
      expect(entryLinks.get("tool")).toBe(await realpath(toolB));
      const snapshot = await createAcpxPrivateSnapshot([runtimeDir, appDir, acpDir, baseDir, toolA, toolB], null, {
        packageLinks: new Map([[await realpath(runtimeDir), entryLinks]]),
      });
      try {
        const linked = JSON.parse(await readFile(join(snapshot.roots[0]!, "node_modules", "tool", "package.json"), "utf8"));
        expect(linked.variant).toBe("runtime");
      } finally { await snapshot.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the first resolved package version in shared entry roots", () => {
    const links = dshEntryPackageLinks([
      { name: "zod", directory: "/packages/zod-first" },
      { name: "zod", directory: "/packages/zod-second" },
    ], "/packages/dsh");
    expect(links.get("zod")).toBe("/packages/zod-first");
    expect(links.get("@deepseek-ai/dsh")).toBe("/packages/dsh");
  });

  it("allows the exact deduplicated limit and rejects only the next unique package", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-package-limit-"));
    const manifests = new Map<string, string>();
    const add = async (name: string, metadata: Record<string, unknown>) => {
      const directory = join(root, name);
      await mkdir(directory, { recursive: true });
      const path = join(directory, "package.json");
      await writeFile(path, JSON.stringify({ name, ...metadata }));
      manifests.set(name, path);
    };
    try {
      const dependencies: Record<string, string> = {};
      for (let index = 0; index < 2044; index++) {
        const name = `pkg-${index}`;
        dependencies[name] = "1";
        await add(name, { version: "1" });
      }
      await add("@deepseek-ai/dsh", { version: "0.2.1-rc.5" });
      await add("@deepseek-ai/dsh-app-boot", { version: "0.2.1-rc.5", dependencies: { ...dependencies, "pkg-0": "1" } });
      await add("@deepseek-ai/dsh-acp-app", { version: "0.2.1-rc.5" });
      await add("@deepseek-ai/dsh-base", { version: "0.2.1-rc.5" });
      const profile = resolveQualifiedAcpxProfile("dsh", "deepseek-v4-flash");
      const resolve = (name: string): string => {
        const path = manifests.get(name);
        if (!path) throw Object.assign(new Error(`missing ${name}`), { code: "MODULE_NOT_FOUND" });
        return path;
      };
      const input = { profile, resolvePackageJson: resolve, serverPackageJsonPath: manifests.get("@deepseek-ai/dsh-app-boot")! };
      const closure = await collectDshProviderPackages(input);
      expect(closure.packages).toHaveLength(2048);
      await add("pkg-overflow", { version: "1" });
      dependencies["pkg-overflow"] = "1";
      await add("@deepseek-ai/dsh", { version: "0.2.1-rc.5" });
      await add("@deepseek-ai/dsh-app-boot", { version: "0.2.1-rc.5", dependencies: { ...dependencies, "pkg-0": "1" } });
      await expect(collectDshProviderPackages(input)).rejects.toThrow("exceeds its bound");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
