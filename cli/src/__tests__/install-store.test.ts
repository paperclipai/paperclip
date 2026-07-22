import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INSTALL_MANIFEST_VERSION,
  MANAGED_SHIM_MARKER,
  addManagedPathBlock,
  buildNextManifest,
  flipCurrentAtomic,
  payloadPathFor,
  pruneInstallPayloads,
  readInstallManifest,
  removeManagedPathBlock,
  resolveInstallStorePaths,
  writeInstallManifestAtomic,
  writeManagedShim,
  type InstallManifest,
  type InstallRecord,
} from "../install-store.js";

function record(payloadPath: string, version: string): InstallRecord {
  return {
    source: "npm",
    version,
    channel: "latest",
    payloadPath,
    installedAt: `2026-07-${version.padStart(2, "0")}T00:00:00.000Z`,
  };
}

describe("managed install store", () => {
  let root: string;
  let paths: ReturnType<typeof resolveInstallStorePaths>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-store-"));
    paths = resolveInstallStorePaths({
      homeDir: path.join(root, "home"),
      paperclipHome: path.join(root, "home", ".paperclip"),
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves the documented npm and git payload layout", () => {
    expect(payloadPathFor(paths, "npm", "2026.720.0")).toBe(
      path.join(paths.cliRoot, "installs", "npm", "2026.720.0"),
    );
    expect(payloadPathFor(paths, "git", "ab12cd34ef56")).toBe(
      path.join(paths.cliRoot, "installs", "git", "ab12cd34ef56"),
    );
  });

  it("writes and reads the manifest atomically with private permissions", () => {
    const payloadPath = payloadPathFor(paths, "npm", "1.2.3");
    const manifest: InstallManifest = {
      schemaVersion: INSTALL_MANIFEST_VERSION,
      ...record(payloadPath, "1.2.3"),
      previous: [],
    };
    writeInstallManifestAtomic(manifest, paths);
    expect(readInstallManifest(paths)).toEqual(manifest);
    expect(fs.statSync(paths.manifestPath).mode & 0o777).toBe(0o600);
  });

  it("leaves the old current payload working when interrupted before rename", () => {
    const oldPayload = payloadPathFor(paths, "npm", "1.0.0");
    const newPayload = payloadPathFor(paths, "npm", "2.0.0");
    fs.mkdirSync(oldPayload, { recursive: true });
    fs.mkdirSync(newPayload, { recursive: true });
    flipCurrentAtomic(oldPayload, paths);

    expect(() =>
      flipCurrentAtomic(newPayload, paths, {
        beforeRename: () => {
          throw new Error("simulated crash");
        },
      }),
    ).toThrow("simulated crash");

    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(oldPayload));
    expect(fs.readdirSync(paths.cliRoot).filter((entry) => entry.startsWith(".current-"))).toEqual([]);
  });

  it("retains current plus two previous payloads and prunes older entries", () => {
    const payloads = ["1", "2", "3", "4"].map((version) => payloadPathFor(paths, "npm", version));
    for (const payload of payloads) fs.mkdirSync(payload, { recursive: true });
    const previousManifest: InstallManifest = {
      schemaVersion: INSTALL_MANIFEST_VERSION,
      ...record(payloads[2], "3"),
      previous: [record(payloads[1], "2"), record(payloads[0], "1")],
    };
    const next = buildNextManifest(record(payloads[3], "4"), previousManifest);

    expect(next.previous.map((entry) => entry.version)).toEqual(["3", "2"]);
    expect(pruneInstallPayloads(next, paths)).toEqual([payloads[0]]);
    expect(fs.existsSync(payloads[0])).toBe(false);
    expect(payloads.slice(1).every((payload) => fs.existsSync(payload))).toBe(true);
  });

  it("writes a stable shim and manages an idempotent shell PATH block", () => {
    writeManagedShim(paths);
    const shim = fs.readFileSync(paths.shimPath, "utf8");
    expect(shim).toContain("$PAPERCLIP_HOME/cli/current/node_modules/paperclipai/dist/index.js");
    expect(fs.statSync(paths.shimPath).mode & 0o777).toBe(0o755);

    const rcPath = path.join(root, "home", ".bashrc");
    expect(addManagedPathBlock(rcPath)).toBe(true);
    expect(addManagedPathBlock(rcPath)).toBe(false);
    expect(removeManagedPathBlock(rcPath)).toBe(true);
    expect(fs.readFileSync(rcPath, "utf8")).not.toContain("paperclipai managed PATH");
  });

  it("refuses symlinked payload roots and pre-existing non-managed shims", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(paths.installsRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(paths.installsRoot, "npm"), "dir");
    const escapedPayload = path.join(paths.installsRoot, "npm", "1.2.3");
    fs.mkdirSync(path.join(outside, "1.2.3"));
    expect(() => flipCurrentAtomic(escapedPayload, paths)).toThrow("resolves outside");

    fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
    fs.writeFileSync(paths.shimPath, "#!/bin/sh\necho other-command\n");
    expect(() => writeManagedShim(paths)).toThrow("non-managed command");
  });

  it("refuses symlinked rc files, unsafe shim parents, and multiply linked shims", () => {
    const outsideRc = path.join(root, "outside-rc");
    fs.writeFileSync(outsideRc, "keep\n");
    const rcPath = path.join(root, "home", ".bashrc");
    fs.mkdirSync(path.dirname(rcPath), { recursive: true });
    fs.symlinkSync(outsideRc, rcPath);
    expect(() => addManagedPathBlock(rcPath)).toThrow("non-regular shell rc file");
    expect(() => removeManagedPathBlock(rcPath)).toThrow("non-regular shell rc file");
    expect(fs.readFileSync(outsideRc, "utf8")).toBe("keep\n");

    fs.rmSync(rcPath);
    const localDir = path.join(root, "home", ".local");
    const outsideBin = path.join(root, "outside-bin");
    fs.mkdirSync(outsideBin);
    fs.symlinkSync(outsideBin, localDir, "dir");
    expect(() => writeManagedShim(paths)).toThrow("unsafe shim directory");

    fs.rmSync(localDir);
    fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
    fs.writeFileSync(paths.shimPath, `# ${MANAGED_SHIM_MARKER}\n`);
    fs.linkSync(paths.shimPath, path.join(root, "linked-shim"));
    expect(() => writeManagedShim(paths)).toThrow("multiply linked shim");
  });
});
