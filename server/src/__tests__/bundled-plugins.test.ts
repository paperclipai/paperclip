import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_PLUGIN_CATALOG,
  DEFAULT_BUNDLED_CATALOG_ROOT,
  SELF_HOSTED_AUTO_INSTALL_KEYS,
  ensureBundledPlugins,
  resolveBundledCatalogRoot,
  resolveBundledPluginInstalls,
  type BundledPluginProvisionerDeps,
  type ResolvedBundledPlugin,
} from "../services/bundled-plugins.js";

const CATALOG_ROOT = "/app/packages/plugins";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Catalog-root resolution (fail-to-start allowlist)
// ---------------------------------------------------------------------------

describe("resolveBundledPluginInstalls", () => {
  it("resolves known keys to paths inside the catalog root", () => {
    const resolved = resolveBundledPluginInstalls(["kubernetes", "daytona"], {
      catalogRoot: CATALOG_ROOT,
      env: {},
      enforceCatalogRoot: true,
    });
    expect(resolved).toEqual([
      {
        key: "kubernetes",
        pluginKey: "paperclip.kubernetes-sandbox-provider",
        localPath: path.join(CATALOG_ROOT, "sandbox-providers/kubernetes"),
      },
      {
        key: "daytona",
        pluginKey: "paperclip.daytona-sandbox-provider",
        localPath: path.join(CATALOG_ROOT, "sandbox-providers/daytona"),
      },
    ]);
  });

  it("throws on a key outside the bundled catalog (fail to start)", () => {
    expect(() =>
      resolveBundledPluginInstalls(["kubernetes", "not-a-bundled-plugin"], {
        catalogRoot: CATALOG_ROOT,
        env: {},
        enforceCatalogRoot: true,
      }),
    ).toThrow(/"not-a-bundled-plugin" is not in the bundled catalog.*refusing to start/);
  });

  it("names the known catalog keys in the unknown-key error", () => {
    expect(() =>
      resolveBundledPluginInstalls(["nope"], {
        catalogRoot: CATALOG_ROOT,
        env: {},
        enforceCatalogRoot: true,
      }),
    ).toThrow(new RegExp(BUNDLED_PLUGIN_CATALOG.map((entry) => entry.key).join(", ")));
  });

  it("resolves an empty key list to no installs", () => {
    expect(
      resolveBundledPluginInstalls([], {
        catalogRoot: CATALOG_ROOT,
        env: {},
        enforceCatalogRoot: true,
      }),
    ).toEqual([]);
  });

  it("throws when an env override escapes the catalog root under enforcement", () => {
    expect(() =>
      resolveBundledPluginInstalls(["kubernetes"], {
        catalogRoot: CATALOG_ROOT,
        env: { PAPERCLIP_KUBERNETES_PLUGIN_PATH: "/srv/evil/plugin" },
        enforceCatalogRoot: true,
      }),
    ).toThrow(/outside the bundled catalog root.*refusing to start/);
  });

  it("collapses `..` segments in an override before the containment check", () => {
    expect(() =>
      resolveBundledPluginInstalls(["kubernetes"], {
        catalogRoot: CATALOG_ROOT,
        env: {
          PAPERCLIP_KUBERNETES_PLUGIN_PATH: path.join(
            CATALOG_ROOT,
            "sandbox-providers/../../../../etc/kubernetes",
          ),
        },
        enforceCatalogRoot: true,
      }),
    ).toThrow(/outside the bundled catalog root/);
  });

  it("throws when a symlink inside the root points outside it under enforcement", () => {
    const outside = makeTempDir("bundled-outside-");
    const root = makeTempDir("bundled-root-");
    mkdirSync(path.join(root, "sandbox-providers"), { recursive: true });
    symlinkSync(outside, path.join(root, "sandbox-providers", "kubernetes"));
    expect(() =>
      resolveBundledPluginInstalls(["kubernetes"], {
        catalogRoot: root,
        env: {},
        enforceCatalogRoot: true,
      }),
    ).toThrow(/outside the bundled catalog root/);
  });

  it("honors the legacy kubernetes path override without enforcement (self-hosted)", () => {
    const resolved = resolveBundledPluginInstalls(["kubernetes"], {
      catalogRoot: CATALOG_ROOT,
      env: { PAPERCLIP_KUBERNETES_PLUGIN_PATH: "/somewhere/else/kubernetes" },
      enforceCatalogRoot: false,
    });
    expect(resolved).toEqual([
      {
        key: "kubernetes",
        pluginKey: "paperclip.kubernetes-sandbox-provider",
        localPath: "/somewhere/else/kubernetes",
      },
    ]);
  });

  it("honors an env override that stays inside the catalog root under enforcement", () => {
    const inside = path.join(CATALOG_ROOT, "sandbox-providers", "kubernetes");
    const resolved = resolveBundledPluginInstalls(["kubernetes"], {
      catalogRoot: CATALOG_ROOT,
      env: { PAPERCLIP_KUBERNETES_PLUGIN_PATH: inside },
      enforceCatalogRoot: true,
    });
    expect(resolved[0]!.localPath).toBe(inside);
  });

  it("dedupes repeated keys", () => {
    const resolved = resolveBundledPluginInstalls(["kubernetes", "kubernetes"], {
      catalogRoot: CATALOG_ROOT,
      env: {},
      enforceCatalogRoot: true,
    });
    expect(resolved).toHaveLength(1);
  });

  it("keeps the self-hosted default list to exactly the kubernetes bundle", () => {
    expect(SELF_HOSTED_AUTO_INSTALL_KEYS).toEqual(["kubernetes"]);
    const [entry] = resolveBundledPluginInstalls(SELF_HOSTED_AUTO_INSTALL_KEYS, {
      catalogRoot: resolveBundledCatalogRoot({}),
      env: {},
      enforceCatalogRoot: false,
    });
    // Exactly the pre-refactor default path.
    expect(entry).toEqual({
      key: "kubernetes",
      pluginKey: "paperclip.kubernetes-sandbox-provider",
      localPath: "/app/packages/plugins/sandbox-providers/kubernetes",
    });
  });

  it("covers every catalog entry with a path inside the default root", () => {
    const keys = BUNDLED_PLUGIN_CATALOG.map((entry) => entry.key);
    const resolved = resolveBundledPluginInstalls(keys, {
      catalogRoot: DEFAULT_BUNDLED_CATALOG_ROOT,
      env: {},
      enforceCatalogRoot: true,
    });
    expect(resolved).toHaveLength(BUNDLED_PLUGIN_CATALOG.length);
  });
});

describe("resolveBundledCatalogRoot", () => {
  it("defaults to the image catalog root", () => {
    expect(resolveBundledCatalogRoot({})).toBe(DEFAULT_BUNDLED_CATALOG_ROOT);
  });

  it("honors PAPERCLIP_BUNDLED_PLUGIN_ROOT", () => {
    expect(resolveBundledCatalogRoot({ PAPERCLIP_BUNDLED_PLUGIN_ROOT: "/custom/root" })).toBe(
      "/custom/root",
    );
  });
});

// ---------------------------------------------------------------------------
// ensureBundledPlugins (fail-safe installer)
// ---------------------------------------------------------------------------

type LooseRow = {
  id: string;
  pluginKey: string;
  status: string;
  version?: string;
  manifestJson?: Record<string, unknown>;
};

// Build a minimal manifest for a persisted row or a shipped bundle. The reconcile
// step compares the bundle version with the persisted version.
function makeManifest(pluginKey: string, version: string) {
  return { id: pluginKey, apiVersion: 1, version } as unknown as import("@paperclipai/shared").PaperclipPluginManifestV1;
}

function makeDeps(overrides?: {
  rows?: Record<string, LooseRow | null>;
  bundleManifestExists?: (localPath: string) => boolean;
  installError?: Error;
  /** Version the shipped bundle manifest reports, keyed by pluginKey. */
  bundleVersionByKey?: Record<string, string>;
}) {
  const rows = overrides?.rows ?? {};
  const normalize = (row: LooseRow | null): (LooseRow & { version: string; manifestJson: Record<string, unknown> }) | null => {
    if (!row) return null;
    const version = row.version ?? "0.1.0";
    return {
      ...row,
      version,
      manifestJson: row.manifestJson ?? { id: row.pluginKey, apiVersion: 1, version },
    };
  };
  const installedRows = new Map(
    Object.entries(rows).map(([key, row]) => [key, normalize(row)] as const),
  );
  const installPlugin = vi.fn(async ({ localPath }: { localPath: string }) => {
    if (overrides?.installError) throw overrides.installError;
    const entry = BUNDLED_PLUGIN_CATALOG.find((candidate) =>
      localPath.endsWith(candidate.relativePath),
    );
    const pluginKey = entry?.pluginKey ?? "unknown";
    installedRows.set(pluginKey, normalize({ id: `id-${pluginKey}`, pluginKey, status: "installed" }));
    return { manifest: { id: pluginKey } };
  });
  const update = vi.fn(async () => undefined);
  const loadManifest = vi.fn(async (localPath: string) => {
    const entry = BUNDLED_PLUGIN_CATALOG.find((candidate) =>
      localPath.endsWith(candidate.relativePath),
    );
    const pluginKey = entry?.pluginKey ?? "unknown";
    const persisted = installedRows.get(pluginKey);
    // Default: the bundle version matches the persisted version, so no
    // reconcile fires unless a test overrides `bundleVersionByKey`.
    const version = overrides?.bundleVersionByKey?.[pluginKey] ?? persisted?.version ?? "0.1.0";
    return makeManifest(pluginKey, version);
  });
  const deps: BundledPluginProvisionerDeps = {
    registry: {
      getByKey: vi.fn(async (pluginKey: string) => installedRows.get(pluginKey) ?? null),
      update,
    } as unknown as BundledPluginProvisionerDeps["registry"],
    loader: { installPlugin, loadManifest } as unknown as BundledPluginProvisionerDeps["loader"],
    lifecycle: { load: vi.fn(async () => undefined) },
    logger: { info: vi.fn(), error: vi.fn() },
    bundleManifestExists: overrides?.bundleManifestExists ?? (() => true),
  };
  return { deps, installPlugin, update, loadManifest };
}

const K8S: ResolvedBundledPlugin = {
  key: "kubernetes",
  pluginKey: "paperclip.kubernetes-sandbox-provider",
  localPath: path.join(CATALOG_ROOT, "sandbox-providers/kubernetes"),
};
const DAYTONA: ResolvedBundledPlugin = {
  key: "daytona",
  pluginKey: "paperclip.daytona-sandbox-provider",
  localPath: path.join(CATALOG_ROOT, "sandbox-providers/daytona"),
};

describe("ensureBundledPlugins", () => {
  it("installs and loads a missing bundled plugin", async () => {
    const { deps, installPlugin } = makeDeps();
    await ensureBundledPlugins([K8S], deps, { reinstallUninstalled: true });
    expect(installPlugin).toHaveBeenCalledWith({ localPath: K8S.localPath });
    expect(deps.lifecycle.load).toHaveBeenCalledWith(
      "id-paperclip.kubernetes-sandbox-provider",
    );
  });

  it("skips a plugin present in any non-uninstalled state (disabled is not re-enabled)", async () => {
    for (const status of ["installed", "ready", "disabled", "error"]) {
      const { deps, installPlugin } = makeDeps({
        rows: {
          [K8S.pluginKey]: { id: "row-1", pluginKey: K8S.pluginKey, status },
        },
      });
      await ensureBundledPlugins([K8S], deps, { reinstallUninstalled: true });
      expect(installPlugin).not.toHaveBeenCalled();
      expect(deps.lifecycle.load).not.toHaveBeenCalled();
    }
  });

  it("reconciles the persisted manifest of a present plugin when the bundle version changed", async () => {
    const { deps, installPlugin, update } = makeDeps({
      rows: {
        [DAYTONA.pluginKey]: {
          id: "row-daytona",
          pluginKey: DAYTONA.pluginKey,
          status: "ready",
          version: "0.1.1",
        },
      },
      bundleVersionByKey: { [DAYTONA.pluginKey]: "0.1.2" },
    });
    await ensureBundledPlugins([DAYTONA], deps, { reinstallUninstalled: false });
    // The plugin stays present, so it is never re-installed.
    expect(installPlugin).not.toHaveBeenCalled();
    // The persisted manifest is refreshed to the shipped bundle version, so a
    // capability added to the bundle reaches the existing install.
    expect(update).toHaveBeenCalledWith(
      "row-daytona",
      expect.objectContaining({ version: "0.1.2" }),
    );
  });

  it("does not reconcile when the persisted version already matches the bundle", async () => {
    const { deps, update } = makeDeps({
      rows: {
        [DAYTONA.pluginKey]: {
          id: "row-daytona",
          pluginKey: DAYTONA.pluginKey,
          status: "ready",
          version: "0.1.2",
        },
      },
      bundleVersionByKey: { [DAYTONA.pluginKey]: "0.1.2" },
    });
    await ensureBundledPlugins([DAYTONA], deps, { reinstallUninstalled: false });
    expect(update).not.toHaveBeenCalled();
  });

  it("swallows a reconcile error and continues boot", async () => {
    const { deps, update } = makeDeps({
      rows: {
        [DAYTONA.pluginKey]: {
          id: "row-daytona",
          pluginKey: DAYTONA.pluginKey,
          status: "ready",
          version: "0.1.1",
        },
      },
      bundleVersionByKey: { [DAYTONA.pluginKey]: "0.1.2" },
    });
    (update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    await expect(
      ensureBundledPlugins([DAYTONA], deps, { reinstallUninstalled: false }),
    ).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("reinstalls a soft-uninstalled plugin in managed mode", async () => {
    const { deps, installPlugin } = makeDeps({
      rows: {
        [K8S.pluginKey]: { id: "row-1", pluginKey: K8S.pluginKey, status: "uninstalled" },
      },
    });
    await ensureBundledPlugins([K8S], deps, { reinstallUninstalled: true });
    expect(installPlugin).toHaveBeenCalledOnce();
  });

  it("leaves a soft-uninstalled plugin alone in self-hosted mode (pre-refactor behavior)", async () => {
    const { deps, installPlugin } = makeDeps({
      rows: {
        [K8S.pluginKey]: { id: "row-1", pluginKey: K8S.pluginKey, status: "uninstalled" },
      },
    });
    await ensureBundledPlugins([K8S], deps, { reinstallUninstalled: false });
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it("skips silently when the bundle is absent on disk", async () => {
    const { deps, installPlugin } = makeDeps({ bundleManifestExists: () => false });
    await ensureBundledPlugins([K8S], deps, { reinstallUninstalled: true });
    expect(installPlugin).not.toHaveBeenCalled();
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it("logs and continues past a failing install, still processing later entries", async () => {
    const { deps, installPlugin } = makeDeps();
    installPlugin.mockRejectedValueOnce(new Error("disk exploded"));
    await expect(
      ensureBundledPlugins([K8S, DAYTONA], deps, { reinstallUninstalled: true }),
    ).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: K8S.pluginKey }),
      expect.stringContaining("continuing boot"),
    );
    // Daytona still installed after the kubernetes failure.
    expect(installPlugin).toHaveBeenCalledTimes(2);
    expect(deps.lifecycle.load).toHaveBeenCalledWith("id-paperclip.daytona-sandbox-provider");
  });

  it("never uninstalls anything: plugins absent from the list are untouched", async () => {
    const { deps, installPlugin } = makeDeps({
      rows: {
        [DAYTONA.pluginKey]: { id: "row-d", pluginKey: DAYTONA.pluginKey, status: "ready" },
      },
    });
    // Daytona was removed from the autoInstall list; only kubernetes remains.
    await ensureBundledPlugins([K8S], deps, { reinstallUninstalled: true });
    expect(installPlugin).toHaveBeenCalledOnce();
    expect(installPlugin).toHaveBeenCalledWith({ localPath: K8S.localPath });
    // No uninstall/unload calls exist on the provisioner deps at all; daytona
    // was never queried beyond its own key and its row is untouched.
    expect(deps.lifecycle.load).toHaveBeenCalledTimes(1);
  });

  it("logs an error and does not load when install returns no manifest", async () => {
    const { deps, installPlugin } = makeDeps();
    installPlugin.mockResolvedValueOnce({ manifest: null });
    await ensureBundledPlugins([K8S], deps, { reinstallUninstalled: true });
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: K8S.pluginKey }),
      expect.stringContaining("manifest is missing"),
    );
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
  });

  it("logs an error when the installed plugin never appears in the registry", async () => {
    const { deps, installPlugin } = makeDeps();
    (deps.registry.getByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await ensureBundledPlugins([K8S], deps, { reinstallUninstalled: true });
    expect(installPlugin).toHaveBeenCalledOnce();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: K8S.pluginKey }),
      expect.stringContaining("not found in registry"),
    );
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
  });

  it("checks the real bundle manifest path by default (dist/manifest.js)", async () => {
    const bundleDir = makeTempDir("bundled-bundle-");
    const { deps, installPlugin } = makeDeps();
    delete deps.bundleManifestExists;
    const install = { ...K8S, localPath: bundleDir };
    await ensureBundledPlugins([install], deps, { reinstallUninstalled: true });
    expect(installPlugin).not.toHaveBeenCalled();
    mkdirSync(path.join(bundleDir, "dist"), { recursive: true });
    writeFileSync(path.join(bundleDir, "dist", "manifest.js"), "module.exports = {}\n");
    await ensureBundledPlugins([install], deps, { reinstallUninstalled: true });
    expect(installPlugin).toHaveBeenCalledOnce();
  });
});
