import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Behavioral tests for scripts/docker-entrypoint.sh privilege handling.
 *
 * The entrypoint must support two deployment shapes with one image:
 *  - Docker Compose: container starts as root, remaps the node user to
 *    USER_UID/USER_GID and drops privileges via gosu.
 *  - Kubernetes restricted PodSecurity / OpenShift arbitrary UIDs: the
 *    container starts non-root, where neither the remap nor gosu can work,
 *    so the command must be exec'd directly (with a warning on mismatch).
 *
 * The system commands (id, usermod, groupmod, chown, gosu) are stubbed via
 * PATH so the branching logic runs unmodified on any host.
 */

const ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "docker-entrypoint.sh");

let stubDir: string;
let logFile: string;

function writeStub(name: string, body: string) {
  const path = join(stubDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

type StubOptions = {
  uid: number;
  gid: number;
  nodeUid?: number;
  nodeGid?: number;
  /** Mismatch anywhere: both the shallow and the full-tree probe find it. */
  homeMismatch?: boolean;
  /** Mismatch only below the shallow probe depth: just the full-tree probe finds it. */
  deepMismatch?: boolean;
  /** The full-tree find exits non-zero without printing a mismatch (e.g. an I/O error). */
  fullProbeFails?: boolean;
};

function installStubs(ids: StubOptions) {
  writeStub(
    "id",
    [
      `if [ "$1" = "-u" ] && [ "$2" = "node" ]; then echo ${ids.nodeUid ?? 1000};`,
      `elif [ "$1" = "-g" ] && [ "$2" = "node" ]; then echo ${ids.nodeGid ?? 1000};`,
      `elif [ "$1" = "-u" ]; then echo ${ids.uid};`,
      `elif [ "$1" = "-g" ]; then echo ${ids.gid};`,
      `else echo 0; fi`,
    ].join("\n"),
  );
  for (const cmd of ["usermod", "groupmod", "chown"]) {
    writeStub(cmd, `echo "${cmd} $*" >> "${logFile}"`);
  }
  // The entrypoint's ownership probes are first-mismatch finds over the app
  // home: a shallow one bounded by -maxdepth, and a full-tree one. An empty
  // result models a node-owned tree (image-baked dir, healthy volume); a
  // path models a uid OR gid mismatch (fresh root-owned mount, root-owned
  // descendant, stale group after a GID-only remap). Each call is logged as
  // "find-shallow" or "find-full" so tests can assert which walks ran.
  writeStub(
    "find",
    [
      `case " $* " in`,
      `  *" -maxdepth "*) echo "find-shallow $1" >> "${logFile}"; ${ids.homeMismatch ? `echo "$1/mismatched-entry"` : "true"} ;;`,
      `  *) echo "find-full $1" >> "${logFile}"; ${ids.homeMismatch || ids.deepMismatch ? `echo "$1/deep/mismatched-entry"` : ids.fullProbeFails ? "exit 1" : "true"} ;;`,
      `esac`,
    ].join("\n"),
  );
  writeStub("gosu", `echo "gosu $*" >> "${logFile}"\nshift\nexec "$@"`);
}

async function runEntrypoint(env: Record<string, string> = {}) {
  const result = await execFileAsync("sh", [ENTRYPOINT, "echo", "ENTRYPOINT-CMD-RAN"], {
    env: { PATH: `${stubDir}:${process.env.PATH}`, ...env },
  });
  const calls = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  return { stdout: result.stdout, stderr: result.stderr, calls };
}

beforeEach(() => {
  stubDir = mkdtempSync(join(tmpdir(), "entrypoint-stubs-"));
  logFile = join(stubDir, "calls.log");
});

afterEach(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

describe("docker-entrypoint.sh", () => {
  it("keeps the root-start gosu flow with default UID/GID (Docker Compose)", async () => {
    installStubs({ uid: 0, gid: 0 });

    const { stdout, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
    expect(calls).not.toContain("usermod");
    expect(calls).not.toContain("chown");
  });

  it("remaps the node user and chowns /paperclip before gosu when root requests a different UID/GID", async () => {
    // The stubbed node uid stays 1000 while the stat probe reports the old
    // ownership, modelling the post-remap mismatch that must trigger chown.
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { stdout, calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain("usermod -o -u 1001 node");
    expect(calls).toContain("groupmod -o -g 1001 node");
    expect(calls).toContain(`chown -R node:node ${stubDir}`);
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it.each([false, true])("skips remapping a cloud identity while preserving volume repair (mismatch: %s)", async (homeMismatch) => {
    installStubs({ uid: 0, gid: 0, nodeUid: 1001, nodeGid: 1001, homeMismatch });

    const { stdout, calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).not.toContain("usermod");
    expect(calls).not.toContain("groupmod");
    expect(calls.includes(`chown -R node:node ${stubDir}`)).toBe(homeMismatch);
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("chowns a root-owned home before gosu even with the default UID/GID (fresh volume mount)", async () => {
    // A freshly mounted volume arrives root-owned and shadows the image's
    // build-time chown; with no remap requested the old entrypoint dropped
    // privileges onto an unwritable home and the server crashed on its
    // first mkdir.
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { stdout, calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain(`chown -R node:node ${stubDir}`);
    expect(calls).not.toContain("usermod");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("repairs ownership on a GID-only remap (stale group on persisted descendants)", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { calls } = await runEntrypoint({ USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(calls).toContain("groupmod -o -g 1001 node");
    expect(calls).toContain(`chown -R node:node ${stubDir}`);
  });

  it("keeps a fully node-owned tree chown-free (no per-boot recursive chown)", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: false });

    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(calls).not.toContain("chown");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("honours PAPERCLIP_HOME for the ownership probe", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(calls).toContain(`chown -R node:node ${stubDir}`);
  });

  describe("ownership probe cost", () => {
    const marker = () => join(stubDir, ".paperclip-ownership-verified");

    it("skips the full-tree walk when ownership is correct and the marker is current", async () => {
      installStubs({ uid: 0, gid: 0 });
      writeFileSync(marker(), "v1 1000:1000\n");

      const { stdout, calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

      expect(calls).toContain(`find-shallow ${stubDir}`);
      expect(calls).not.toContain("find-full");
      expect(calls).not.toContain("chown");
      expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    });

    it("skips the full-tree walk when the marker is current, even with a deep mismatch", async () => {
      // The marker is the trade-off that keeps boots O(1): once a tree has
      // been verified, only the shallow levels are re-checked.
      installStubs({ uid: 0, gid: 0, deepMismatch: true });
      writeFileSync(marker(), "v1 1000:1000\n");

      const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

      expect(calls).not.toContain("find-full");
      expect(calls).not.toContain("chown");
    });

    it("runs one full-tree walk without a marker, then records the marker", async () => {
      // First boot after upgrading from an image without the marker.
      installStubs({ uid: 0, gid: 0 });

      const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

      expect(calls).toContain(`find-shallow ${stubDir}`);
      expect(calls).toContain(`find-full ${stubDir}`);
      expect(calls).not.toContain("chown");
      expect(readFileSync(marker(), "utf8")).toBe("v1 1000:1000\n");
    });

    it("does not record the marker when the full-tree walk fails without finding a mismatch", async () => {
      installStubs({ uid: 0, gid: 0, fullProbeFails: true });

      const { stdout, calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

      expect(calls).toContain(`find-full ${stubDir}`);
      expect(calls).not.toContain("chown");
      expect(existsSync(marker())).toBe(false);
      expect(stdout).toContain("failed; it will run again on the next boot");
      expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    });

    it("repairs a deep mismatch found by the full-tree walk when there is no marker", async () => {
      installStubs({ uid: 0, gid: 0, deepMismatch: true });

      const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

      expect(calls).toContain(`find-full ${stubDir}`);
      expect(calls).toContain(`chown -R node:node ${stubDir}`);
      expect(readFileSync(marker(), "utf8")).toBe("v1 1000:1000\n");
    });

    it("repairs a root-owned top level without a full-tree probe, even with a current marker", async () => {
      installStubs({ uid: 0, gid: 0, homeMismatch: true });
      writeFileSync(marker(), "v1 1000:1000\n");

      const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

      expect(calls).toContain(`find-shallow ${stubDir}`);
      expect(calls).not.toContain("find-full");
      expect(calls).toContain(`chown -R node:node ${stubDir}`);
    });

    it("re-runs the full-tree walk when the marker was written for another UID/GID", async () => {
      installStubs({ uid: 0, gid: 0, nodeUid: 1001, nodeGid: 1001, deepMismatch: true });
      writeFileSync(marker(), "v1 1000:1000\n");

      const { calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

      expect(calls).toContain(`find-full ${stubDir}`);
      expect(calls).toContain(`chown -R node:node ${stubDir}`);
      expect(readFileSync(marker(), "utf8")).toBe("v1 1001:1001\n");
    });

    it("logs timestamped start, repair duration, and pre-exec lines", async () => {
      installStubs({ uid: 0, gid: 0, homeMismatch: true });

      const { stdout } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });
      const stamp = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z docker-entrypoint\\.sh: ";

      expect(stdout).toMatch(new RegExp(`^${stamp}starting$`, "m"));
      expect(stdout).toMatch(new RegExp(`^${stamp}ownership repair finished in \\d+s$`, "m"));
      expect(stdout).toMatch(new RegExp(`^${stamp}starting app as node$`, "m"));
      expect(stdout.indexOf("starting app as node")).toBeLessThan(stdout.indexOf("ENTRYPOINT-CMD-RAN"));
    });
  });

  it("execs directly and silently when already running as the requested user (restricted PodSecurity)", async () => {
    installStubs({ uid: 1000, gid: 1000 });

    const { stdout, stderr, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(stderr).toBe("");
    expect(calls).toBe("");
  });

  it("execs directly with a warning for an arbitrary non-root UID (OpenShift-style)", async () => {
    installStubs({ uid: 1234, gid: 1234 });

    const { stdout, stderr, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(stderr).toContain("running unprivileged as 1234:1234; cannot remap to requested 1000:1000");
    expect(calls).toBe("");
  });

  it("execs directly with a warning on a non-root GID mismatch", async () => {
    installStubs({ uid: 1000, gid: 1001 });

    const { stdout, stderr, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(stderr).toContain("running unprivileged as 1000:1001; cannot remap to requested 1000:1000");
    expect(calls).toBe("");
  });
});
