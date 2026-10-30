import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
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
  /** The node user's passwd home; null models a host without a node passwd entry. */
  nodeHome?: string | null;
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
  for (const cmd of ["usermod", "groupmod", "chown", "chmod"]) {
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
  const nodeHome = ids.nodeHome === undefined ? "/paperclip" : ids.nodeHome;
  writeStub(
    "getent",
    nodeHome === null
      ? "exit 2"
      : `if [ "$1" = "passwd" ] && [ "$2" = "node" ]; then echo "node:x:${ids.nodeUid ?? 1000}:${ids.nodeGid ?? 1000}::${nodeHome}:/bin/bash"; else exit 2; fi`,
  );
}

async function runEntrypoint(env: Record<string, string> = {}, script = ENTRYPOINT) {
  const result = await execFileAsync("sh", [script, "echo", "ENTRYPOINT-CMD-RAN"], {
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

  it("moves the app home away during the remap so usermod does not walk it", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: true, nodeHome: stubDir });

    const { calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    const lines = calls.trim().split("\n");
    // usermod re-owns files only under the current home, so every ID change
    // runs while the home points at a placeholder that does not exist.
    expect(lines.filter((line) => line.startsWith("usermod "))).toEqual([
      `usermod -d /nonexistent/paperclip-uid-remap${stubDir} node`,
      "usermod -o -u 1001 node",
      "usermod -g 1001 node",
      `usermod -d ${stubDir} node`,
    ]);
    // The ownership probe still repairs the app home after a real ID change.
    expect(lines.indexOf(`chown -R node:node ${stubDir}`)).toBeGreaterThan(lines.indexOf(`usermod -d ${stubDir} node`));
  });

  it("moves the app home away for a GID-only remap too", async () => {
    installStubs({ uid: 0, gid: 0, nodeUid: 1001, nodeGid: 1000, nodeHome: stubDir });

    const { calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(calls.trim().split("\n").filter((line) => line.startsWith("usermod "))).toEqual([
      `usermod -d /nonexistent/paperclip-uid-remap${stubDir} node`,
      "usermod -g 1001 node",
      `usermod -d ${stubDir} node`,
    ]);
  });

  it("keeps the plain remap when the passwd home is outside the app home", async () => {
    // The ownership probe covers only the app home, so usermod must still
    // re-own a separate passwd home.
    installStubs({ uid: 0, gid: 0, nodeHome: "/paperclip" });

    const { calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(calls).toContain("usermod -o -u 1001 node");
    expect(calls).not.toContain("usermod -d");
  });

  it("remaps without moving the home when the node passwd entry is unavailable", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: true, nodeHome: null });

    const { stdout, calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain("usermod -o -u 1001 node");
    expect(calls).not.toContain("usermod -d");
  });

  it("restores the home left by an interrupted remap when the IDs already match", async () => {
    installStubs({ uid: 0, gid: 0, nodeUid: 1001, nodeGid: 1001, nodeHome: `/nonexistent/paperclip-uid-remap${stubDir}` });

    const { stdout, calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls.trim().split("\n").filter((line) => line.startsWith("usermod "))).toEqual([
      `usermod -d ${stubDir} node`,
    ]);
  });

  it("restores the original home, not the placeholder, when an interrupted remap is retried", async () => {
    installStubs({ uid: 0, gid: 0, nodeHome: `/nonexistent/paperclip-uid-remap${stubDir}` });

    const { calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(calls.trim().split("\n").filter((line) => line.startsWith("usermod "))).toEqual([
      `usermod -d ${stubDir} node`,
      `usermod -d /nonexistent/paperclip-uid-remap${stubDir} node`,
      "usermod -o -u 1001 node",
      "usermod -g 1001 node",
      `usermod -d ${stubDir} node`,
    ]);
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

  describe("managed database stacks", () => {
    const SUPERVISOR_LINE = "managed_db_supervisor=/opt/paperclip-managed-database\n";

    /**
     * The entrypoint with its root-owned supervisor bundle swapped for a stub
     * that prints its arguments, and a minimal jq for the config fields.
     */
    function managedEntrypoint(): string {
      const bundle = join(stubDir, "bundle");
      mkdirSync(bundle);
      writeFileSync(join(bundle, "main.mjs"), `console.log("SUPERVISOR " + process.argv.slice(2).join(" "));\n`);
      writeFileSync(join(bundle, "release.json"), "{}\n");
      writeStub("jq", `exec node -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => { const v = process.argv[1].split(".").slice(1).reduce((o, k) => (o == null ? o : o[k]), JSON.parse(s)); if (v == null) process.exit(1); console.log(v); });' "$2"`);
      const script = readFileSync(ENTRYPOINT, "utf8");
      expect(script).toContain(SUPERVISOR_LINE);
      const path = join(stubDir, "docker-entrypoint.sh");
      writeFileSync(path, script.replace(SUPERVISOR_LINE, `managed_db_supervisor=${bundle}\n`));
      return path;
    }

    function managedEnv(volume: string, root: string) {
      return { PAPERCLIP_HOME: volume, PAPERCLIP_MANAGED_DATABASE: JSON.stringify({ root, volume: { mountPath: volume } }) };
    }

    it("makes every directory from the managed root's parent up to the volume root-owned and sticky", async () => {
      // Rename permission comes from the parent: on a node-owned volume root
      // the app could move the supervisor's root-only directory aside.
      installStubs({ uid: 0, gid: 0 });
      const script = managedEntrypoint();
      const volume = join(stubDir, "volume");
      mkdirSync(join(volume, "system"), { recursive: true });

      const { stdout, calls } = await runEntrypoint(managedEnv(volume, join(volume, "system", ".managed-database")), script);

      expect(stdout).toContain("SUPERVISOR run -- echo ENTRYPOINT-CMD-RAN");
      const lines = calls.trim().split("\n");
      const protectedLines = [
        `chown root:node ${volume}/system`,
        `chmod 1775 ${volume}/system`,
        `chown root:node ${volume}`,
        `chmod 1775 ${volume}`,
      ];
      expect(lines.filter((line) => /^(chown root:node|chmod) /.test(line))).toEqual(protectedLines);
      // After the walk that hands the home to node, which would undo it.
      expect(lines.indexOf(`find-full ${volume}`)).toBeLessThan(lines.indexOf(protectedLines[0]));
    });

    it.each([
      ["outside the mount", (volume: string) => ({ root: join(stubDir, "elsewhere", ".managed-database"), mount: volume })],
      ["escaping the mount with ..", (volume: string) => ({ root: `${volume}/../elsewhere/.managed-database`, mount: volume })],
      ["inside the / mount", () => ({ root: "/srv/.managed-database", mount: "/" })],
      ["below a symbolic link", (volume: string) => {
        symlinkSync(stubDir, join(volume, "link"));
        return { root: join(volume, "link", ".managed-database"), mount: volume };
      }],
    ])("refuses to protect a managed root %s", async (_label, layout) => {
      installStubs({ uid: 0, gid: 0 });
      const script = managedEntrypoint();
      const volume = join(stubDir, "volume");
      mkdirSync(volume);
      const { root, mount } = layout(volume);

      const failure = await runEntrypoint({ PAPERCLIP_HOME: volume, PAPERCLIP_MANAGED_DATABASE: JSON.stringify({ root, volume: { mountPath: mount } }) }, script)
        .then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);

      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toMatch(/managed database root|symbolic link/);
      expect(failure?.stdout).not.toContain("SUPERVISOR");
      const calls = readFileSync(logFile, "utf8");
      expect(calls).not.toContain("chown root:node");
      expect(calls).not.toContain("chmod");
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
