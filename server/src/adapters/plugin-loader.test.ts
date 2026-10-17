import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterLoginCapability } from "@paperclipai/adapter-utils";
import {
  addAdapterPlugin,
  getAdapterPluginByType,
  removeAdapterPlugin,
} from "../services/adapter-plugin-store.js";
import {
  isAnyReloadDirEntry,
  isReloadDirEntry,
  loadExternalAdapterPackage,
  pruneAllReloadDirs,
  pruneReloadDirsForType,
  reloadDirNameForType,
  reloadExternalAdapter,
  sanitizeReloadDirSegment,
  validateAdapterModule,
  withAdapterLock,
  withAdapterLocks,
  lockKeysForType,
} from "./plugin-loader.js";

// A minimal external adapter module. The loader calls `createServerAdapter()`
// and then validates the returned module. Each test controls the returned
// `loginCapability` to check the fail-closed rule at load time.
function makeModule(loginCapability?: unknown) {
  return {
    createServerAdapter: () => ({
      type: "vendor_local",
      execute: async () => ({}),
      testEnvironment: async () => ({}),
      ...(loginCapability === undefined ? {} : { loginCapability }),
    }),
  };
}

const validLoginCapability: AdapterLoginCapability = {
  panelMode: "displayed_code",
  timeoutPolicy: "caller_bounded",
  getCommand: () => "vendor login",
  parsePrompt: () => null,
};

describe("validateAdapterModule login capability", () => {
  it("loads an adapter with no login capability", () => {
    expect(() => validateAdapterModule(makeModule(), "vendor-pkg")).not.toThrow();
  });

  it("loads an adapter with a well-formed login capability", () => {
    expect(() => validateAdapterModule(makeModule(validLoginCapability), "vendor-pkg")).not.toThrow();
  });

  it("rejects an adapter with a malformed login capability", () => {
    const bad = { ...validLoginCapability, panelMode: "hidden_code" };
    expect(() => validateAdapterModule(makeModule(bad), "vendor-pkg")).toThrow(
      /invalid login capability/,
    );
  });

  it("rejects an adapter with a non-object login capability", () => {
    expect(() => validateAdapterModule(makeModule("displayed_code"), "vendor-pkg")).toThrow(
      /invalid login capability/,
    );
  });
});

describe("reloadExternalAdapter nested freshness", () => {
  const prevHome = process.env.PAPERCLIP_HOME;
  let home = "";
  let pkgDir = "";

  async function writeNested(value: string): Promise<void> {
    await fs.writeFile(path.join(pkgDir, "dist", "nested.js"), `export const NESTED_VALUE = "${value}";\n`);
  }

  function markerOf(mod: unknown): unknown {
    return (mod as Record<string, unknown>).marker;
  }

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reload-fixture-"));
    process.env.PAPERCLIP_HOME = home;
    pkgDir = path.join(home, "adapter-plugins", "node_modules", "@test", "reload-fixture");
    await fs.mkdir(path.join(pkgDir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@test/reload-fixture", version: "1.0.0", exports: { ".": "./dist/index.js" } }),
    );
    await fs.writeFile(
      path.join(pkgDir, "dist", "index.js"),
      'import { NESTED_VALUE } from "./nested.js";\n' +
        'import { NESTED_VALUE as LINKED_VALUE } from "./linked.js";\n' +
        "export function createServerAdapter() {\n" +
        '  return { type: "reload_fixture_nested", execute: async () => ({}), testEnvironment: async () => ({}), marker: `${NESTED_VALUE}+${LINKED_VALUE}` };\n' +
        "}\n",
    );
    await writeNested("v1");
    await fs.symlink("./nested.js", path.join(pkgDir, "dist", "linked.js"), "file");
    addAdapterPlugin({
      packageName: "@test/reload-fixture",
      version: "1.0.0",
      type: "reload_fixture_nested",
      installedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    removeAdapterPlugin("reload_fixture_nested");
    if (prevHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("serves fresh nested modules after the package changes on disk", async () => {
    const first = await loadExternalAdapterPackage("@test/reload-fixture");
    expect(markerOf(first)).toBe("v1+v1");

    await writeNested("v2");
    const reloaded = await reloadExternalAdapter("reload_fixture_nested");
    expect(reloaded).not.toBeNull();
    expect(markerOf(reloaded)).toBe("v2+v2");
  });

  it("keeps recent generations and prunes only expired ones", async () => {
    const pluginsDir = path.join(home, "adapter-plugins");
    const reloadDirs = async () =>
      (await fs.readdir(pluginsDir)).filter((name) => isReloadDirEntry(name, "reload_fixture_nested"));

    await writeNested("v2");
    await reloadExternalAdapter("reload_fixture_nested");
    expect(await reloadDirs()).toHaveLength(1);

    await writeNested("v3");
    const reloaded = await reloadExternalAdapter("reload_fixture_nested");
    expect(markerOf(reloaded)).toBe("v3+v3");
    expect(await reloadDirs()).toHaveLength(2);

    await writeNested("v4");
    await reloadExternalAdapter("reload_fixture_nested");
    expect(await reloadDirs()).toHaveLength(3);

    const old = new Date(Date.now() - 2 * 3_600_000);
    for (const name of await reloadDirs()) {
      await fs.utimes(path.join(pluginsDir, name), old, old);
    }

    await writeNested("v5");
    await reloadExternalAdapter("reload_fixture_nested");
    expect(await reloadDirs()).toHaveLength(2);
  });

  it("never matches a sibling type with a longer name", () => {
    const siblingDir = ".reload-reload_fixture_nested_extra-1759360000000-123e4567-e89b-12d3-a456-426614174000";
    const ownDir = ".reload-reload_fixture_nested-1759360000000-123e4567-e89b-12d3-a456-426614174000";
    expect(isReloadDirEntry(siblingDir, "reload_fixture_nested")).toBe(false);
    expect(isReloadDirEntry(ownDir, "reload_fixture_nested")).toBe(true);
    expect(isReloadDirEntry("node_modules", "reload_fixture_nested")).toBe(false);
  });

  it("serializes concurrent reloads of the same adapter", async () => {
    await writeNested("v2");
    const [first, second] = await Promise.all([
      reloadExternalAdapter("reload_fixture_nested"),
      reloadExternalAdapter("reload_fixture_nested"),
    ]);
    expect(markerOf(first)).toBe("v2+v2");
    expect(markerOf(second)).toBe("v2+v2");

    const pluginsDir = path.join(home, "adapter-plugins");
    const entries = await fs.readdir(pluginsDir);
    expect(entries.filter((name) => isReloadDirEntry(name, "reload_fixture_nested")).length).toBeLessThanOrEqual(2);
  });

  it("keepActive prunes stale generations but spares the live copy", async () => {
    await writeNested("v2");
    await reloadExternalAdapter("reload_fixture_nested");
    const pluginsDir = path.join(home, "adapter-plugins");
    const before = (await fs.readdir(pluginsDir)).filter((name) =>
      isReloadDirEntry(name, "reload_fixture_nested"),
    );
    expect(before).toHaveLength(1);

    const stale = reloadDirNameForType("reload_fixture_nested");
    expect(stale).not.toBe(before[0]);
    await fs.mkdir(path.join(pluginsDir, stale), { recursive: true });

    pruneReloadDirsForType("reload_fixture_nested", { keepActive: true });

    const after = await fs.readdir(pluginsDir);
    expect(after).toContain(before[0]);
    expect(after).not.toContain(stale);

    // The map entry is cleared, so startup prune reclaims the spared copy.
    pruneAllReloadDirs();
    expect(await fs.readdir(pluginsDir)).not.toContain(before[0]);
  });

  it("throws on staging failure, keeping the record and leaking no copy", async () => {
    await fs.rm(pkgDir, { recursive: true, force: true });
    await expect(reloadExternalAdapter("reload_fixture_nested")).rejects.toThrow(/Failed to stage reload copy/);
    expect(getAdapterPluginByType("reload_fixture_nested")).toBeDefined();

    const pluginsDir = path.join(home, "adapter-plugins");
    const entries = await fs.readdir(pluginsDir);
    expect(entries.filter((name) => isReloadDirEntry(name, "reload_fixture_nested"))).toHaveLength(0);
  });

  it("returns null only when no plugin record exists", async () => {
    removeAdapterPlugin("reload_fixture_nested");
    const reloaded = await reloadExternalAdapter("reload_fixture_nested");
    expect(reloaded).toBeNull();
  });
});

describe("reloadExternalAdapter bare self-imports", () => {
  const prevHome = process.env.PAPERCLIP_HOME;
  let home = "";
  let pkgDir = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reload-self-"));
    process.env.PAPERCLIP_HOME = home;
    pkgDir = path.join(home, "adapter-plugins", "node_modules", "self-pkg");
    await fs.mkdir(path.join(pkgDir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "self-pkg", version: "1.0.0", main: "dist/index.js" }),
    );
    await fs.writeFile(
      path.join(pkgDir, "dist", "index.js"),
      'import { NESTED_VALUE } from "self-pkg/dist/nested.js";\n' +
        "export function createServerAdapter() {\n" +
        '  return { type: "reload_fixture_self", execute: async () => ({}), testEnvironment: async () => ({}), marker: NESTED_VALUE };\n' +
        "}\n",
    );
    await fs.writeFile(path.join(pkgDir, "dist", "nested.js"), 'export const NESTED_VALUE = "v1";\n');
    addAdapterPlugin({
      packageName: "self-pkg",
      version: "1.0.0",
      type: "reload_fixture_self",
      installedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    removeAdapterPlugin("reload_fixture_self");
    if (prevHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("serves fresh code for bare self-imports after reload", async () => {
    const first = await loadExternalAdapterPackage("self-pkg");
    expect((first as unknown as Record<string, unknown>).marker).toBe("v1");

    await fs.writeFile(path.join(pkgDir, "dist", "nested.js"), 'export const NESTED_VALUE = "v2";\n');
    const reloaded = await reloadExternalAdapter("reload_fixture_self");
    expect(reloaded).not.toBeNull();
    expect((reloaded as unknown as Record<string, unknown>).marker).toBe("v2");
  });
});

describe("reloadExternalAdapter sanitizer collisions", () => {
  const prevHome = process.env.PAPERCLIP_HOME;
  let home = "";
  let pkgDir = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reload-collide-"));
    process.env.PAPERCLIP_HOME = home;
    pkgDir = path.join(home, "adapter-plugins", "node_modules", "col-pkg");
    await fs.mkdir(path.join(pkgDir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "col-pkg", version: "1.0.0", main: "dist/index.js" }),
    );
    await fs.writeFile(
      path.join(pkgDir, "dist", "index.js"),
      "export function createServerAdapter() {\n" +
        '  return { type: "col_fixture", execute: async () => ({}), testEnvironment: async () => ({}) };\n' +
        "}\n",
    );
    for (const type of ["col/a", "col.a"]) {
      addAdapterPlugin({ packageName: "col-pkg", version: "1.0.0", type, installedAt: new Date().toISOString() });
    }
  });

  afterEach(async () => {
    removeAdapterPlugin("col/a");
    removeAdapterPlugin("col.a");
    if (prevHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("keeps colliding sanitized types in distinct directories", async () => {
    expect(sanitizeReloadDirSegment("col/a")).toBe(sanitizeReloadDirSegment("col.a"));

    await reloadExternalAdapter("col/a");
    await reloadExternalAdapter("col.a");

    const pluginsDir = path.join(home, "adapter-plugins");
    const dirsA = (await fs.readdir(pluginsDir)).filter((name) => isReloadDirEntry(name, "col/a"));
    const dirsB = (await fs.readdir(pluginsDir)).filter((name) => isReloadDirEntry(name, "col.a"));
    expect(dirsA).toHaveLength(1);
    expect(dirsB).toHaveLength(1);
    expect(dirsA[0]).not.toBe(dirsB[0]);
    expect(isReloadDirEntry(dirsA[0], "col.a")).toBe(false);
    expect(isReloadDirEntry(dirsB[0], "col/a")).toBe(false);

    const old = new Date(Date.now() - 2 * 3_600_000);
    await fs.utimes(path.join(pluginsDir, dirsA[0]), old, old);
    await fs.utimes(path.join(pluginsDir, dirsB[0]), old, old);
    pruneReloadDirsForType("col/a");

    const entries = await fs.readdir(pluginsDir);
    expect(entries).not.toContain(dirsA[0]);
    expect(entries).toContain(dirsB[0]);
  });
});

describe("reloadExternalAdapter scoped self-imports", () => {
  const prevHome = process.env.PAPERCLIP_HOME;
  let home = "";
  let pkgDir = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reload-scoped-"));
    process.env.PAPERCLIP_HOME = home;
    pkgDir = path.join(home, "adapter-plugins", "node_modules", "@selfscope", "scope-pkg");
    await fs.mkdir(path.join(pkgDir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@selfscope/scope-pkg", version: "1.0.0", main: "dist/index.js" }),
    );
    await fs.writeFile(
      path.join(pkgDir, "dist", "index.js"),
      'import { NESTED_VALUE } from "@selfscope/scope-pkg/dist/nested.js";\n' +
        "export function createServerAdapter() {\n" +
        '  return { type: "reload_fixture_scoped", execute: async () => ({}), testEnvironment: async () => ({}), marker: NESTED_VALUE };\n' +
        "}\n",
    );
    await fs.writeFile(path.join(pkgDir, "dist", "nested.js"), 'export const NESTED_VALUE = "v1";\n');
    addAdapterPlugin({
      packageName: "@selfscope/scope-pkg",
      version: "1.0.0",
      type: "reload_fixture_scoped",
      installedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    removeAdapterPlugin("reload_fixture_scoped");
    if (prevHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("serves fresh code for scoped bare self-imports after reload", async () => {
    const first = await loadExternalAdapterPackage("@selfscope/scope-pkg");
    expect((first as unknown as Record<string, unknown>).marker).toBe("v1");

    await fs.writeFile(path.join(pkgDir, "dist", "nested.js"), 'export const NESTED_VALUE = "v2";\n');
    const reloaded = await reloadExternalAdapter("reload_fixture_scoped");
    expect(reloaded).not.toBeNull();
    expect((reloaded as unknown as Record<string, unknown>).marker).toBe("v2");
  });
});

describe("withAdapterLock", () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("serializes sections of the same key", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const a = withAdapterLock("lock_same", async () => {
      order.push("a-start");
      await gateA;
      order.push("a-end");
    });
    const b = withAdapterLock("lock_same", async () => {
      order.push("b");
    });
    await flush();
    expect(order).toEqual(["a-start"]);
    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("lets different keys overlap", async () => {
    const started = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = withAdapterLock("lock_x", async () => {
      started.add("x");
      await gate;
    });
    const b = withAdapterLock("lock_y", async () => {
      started.add("y");
      await gate;
    });
    await flush();
    expect(started).toEqual(new Set(["x", "y"]));
    release();
    await Promise.all([a, b]);
  });

  it("runs a queued successor after a rejection", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = withAdapterLock("lock_throw", async () => {
      await gate;
      throw new Error("boom");
    });
    const b = withAdapterLock("lock_throw", async () => "next");
    await flush();
    release();
    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe("next");
  });

  it("blocks on any shared key", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let startedA!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const a = withAdapterLocks(["lock_m1", "lock_m2"], async () => {
      order.push("a");
      startedA();
      await gate;
    });
    await startedGate;
    const b = withAdapterLocks(["lock_m2"], async () => {
      order.push("b");
    });
    await flush();
    expect(order).toEqual(["a"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  it("derives type-plus-package keys for npm records", () => {
    addAdapterPlugin({
      packageName: "keys-pkg",
      version: "1.0.0",
      type: "reload_fixture_keys",
      installedAt: new Date().toISOString(),
    });
    try {
      expect(lockKeysForType("reload_fixture_keys")).toEqual(["type:reload_fixture_keys", "pkg:keys-pkg"]);
      expect(lockKeysForType("missing_type")).toEqual(["type:missing_type"]);
    } finally {
      removeAdapterPlugin("reload_fixture_keys");
    }
  });

  describe("queued reload behind a held key", () => {
    const prevHome = process.env.PAPERCLIP_HOME;
    let home = "";
    let pkgDir = "";

    beforeEach(async () => {
      home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reload-lock-"));
      process.env.PAPERCLIP_HOME = home;
      pkgDir = path.join(home, "adapter-plugins", "node_modules", "lock-pkg");
      await fs.mkdir(path.join(pkgDir, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "lock-pkg", version: "1.0.0", main: "dist/index.js" }),
      );
      await fs.writeFile(
        path.join(pkgDir, "dist", "index.js"),
        'import { NESTED_VALUE } from "./nested.js";\n' +
          "export function createServerAdapter() {\n" +
          '  return { type: "reload_fixture_lock", execute: async () => ({}), testEnvironment: async () => ({}), marker: NESTED_VALUE };\n' +
          "}\n",
      );
      await fs.writeFile(path.join(pkgDir, "dist", "nested.js"), 'export const NESTED_VALUE = "v1";\n');
      addAdapterPlugin({
        packageName: "lock-pkg",
        version: "1.0.0",
        type: "reload_fixture_lock",
        installedAt: new Date().toISOString(),
      });
    });

    afterEach(async () => {
      removeAdapterPlugin("reload_fixture_lock");
      if (prevHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = prevHome;
      await fs.rm(home, { recursive: true, force: true });
    });

    async function reloadBehindHeldKey(key: string): Promise<unknown> {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = withAdapterLock(key, () => gate);
      const reloaded = reloadExternalAdapter("reload_fixture_lock");
      await flush();
      await fs.writeFile(path.join(pkgDir, "dist", "nested.js"), 'export const NESTED_VALUE = "v2";\n');
      release();
      await holder;
      return reloaded;
    }

    it("queues behind a held type key", async () => {
      const mod = await reloadBehindHeldKey("type:reload_fixture_lock");
      expect((mod as unknown as Record<string, unknown>).marker).toBe("v2");
    });

    it("queues behind a held package key", async () => {
      const mod = await reloadBehindHeldKey("pkg:lock-pkg");
      expect((mod as unknown as Record<string, unknown>).marker).toBe("v2");
    });
  });
});

describe("reload staging hygiene", () => {
  const prevHome = process.env.PAPERCLIP_HOME;
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reload-hygiene-"));
    process.env.PAPERCLIP_HOME = home;
    await fs.mkdir(path.join(home, "adapter-plugins"), { recursive: true });
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("sanitizes path separators out of reload directory names", () => {
    expect(sanitizeReloadDirSegment("plain_type-1")).toBe("plain_type-1");
    expect(sanitizeReloadDirSegment("evil/../x")).toBe("evil____x");
    const dir = ".reload-evil____x-1759360000000-123e4567-e89b-12d3-a456-426614174000";
    expect(isReloadDirEntry(dir, "evil/../x")).toBe(true);
    expect(isReloadDirEntry(dir, "plain")).toBe(false);
  });

  it("prunes one type without touching siblings or plain entries", async () => {
    const pluginsDir = path.join(home, "adapter-plugins");
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const own = `.reload-type_a-1759360000000-${uuid}`;
    const sibling = `.reload-type_b-1759360000000-${uuid}`;
    await fs.mkdir(path.join(pluginsDir, own), { recursive: true });
    await fs.mkdir(path.join(pluginsDir, sibling), { recursive: true });
    await fs.mkdir(path.join(pluginsDir, "node_modules"), { recursive: true });

    pruneReloadDirsForType("type_a");

    const entries = await fs.readdir(pluginsDir);
    expect(entries).not.toContain(own);
    expect(entries).toContain(sibling);
    expect(entries).toContain("node_modules");
  });

  it("prunes every reload directory on startup without touching plain entries", async () => {
    const pluginsDir = path.join(home, "adapter-plugins");
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const first = `.reload-type_a-1759360000000-${uuid}`;
    const second = `.reload-type_b-1759360000000-${uuid}`;
    await fs.mkdir(path.join(pluginsDir, first), { recursive: true });
    await fs.mkdir(path.join(pluginsDir, second), { recursive: true });
    await fs.mkdir(path.join(pluginsDir, "node_modules"), { recursive: true });

    expect(isAnyReloadDirEntry(first)).toBe(true);
    expect(isAnyReloadDirEntry("node_modules")).toBe(false);
    pruneAllReloadDirs();

    const entries = await fs.readdir(pluginsDir);
    expect(entries.sort()).toEqual(["node_modules", "package.json"]);
  });
});
