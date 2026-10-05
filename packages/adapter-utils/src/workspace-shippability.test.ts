import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPlainAbsoluteRemoteDir,
  buildRemoteDestinationPrecheckScript,
  buildRemoteDestinationRepairScript,
  buildWorkspacePackArgs,
  classifyTransferFailure,
  isTarDiagnostic,
  isWorkspaceUnshippableError,
  parseRemoteDestinationPrecheckOutput,
  parseTarFaultPaths,
  rehearseWorkspacePack,
  REMOTE_DESTINATION_FAULT_MARKER,
  REMOTE_DESTINATION_OK_MARKER,
  requirePackableWorkspace,
  stripSshNoise,
  WORKSPACE_TRANSFER_STAGES,
  WorkspaceUnshippableError,
} from "./workspace-shippability.js";
import { shellQuote } from "./ssh.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

// Every fixture chmods something to 000. Teardown restores access first, or
// `rm -rf` cannot empty the directory it is trying to remove -- which is the
// very fault these tests reproduce, and it leaks fixtures into the temp dir
// when it bites.
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (!root) continue;
    try {
      await execFileAsync("chmod", ["-R", "u+rwX", root]);
    } catch {
      // Already accessible, or already gone.
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-shippability-"));
  roots.push(root);
  return root;
}

describe("the rehearsal cannot drift from the shipment", () => {
  it("differs from the real upload in the output argument and nothing else", () => {
    // The real upload's arguments, copied from `syncDirectoryToSsh`'s call.
    const shipment = buildWorkspacePackArgs({
      localDir: "/w",
      exclude: ["node_modules", ".git"],
      followSymlinks: true,
      output: "-",
    });
    const rehearsal = buildWorkspacePackArgs({
      localDir: "/w",
      exclude: ["node_modules", ".git"],
      followSymlinks: true,
      output: os.devNull,
    });

    expect(rehearsal).toEqual(shipment.map((arg) => (arg === "-" ? os.devNull : arg)));
    expect(shipment.filter((arg) => arg === "-")).toHaveLength(1);
  });

  it("carries the AppleDouble exclude the shipment carries", () => {
    expect(buildWorkspacePackArgs({ localDir: "/w", output: "-" })).toContain("._*");
  });

  it("omits -h unless the caller follows symlinks", () => {
    expect(buildWorkspacePackArgs({ localDir: "/w", output: "-" })).not.toContain("-h");
    expect(
      buildWorkspacePackArgs({ localDir: "/w", followSymlinks: true, output: "-" }),
    ).toContain("-h");
  });
});

describe("rehearseWorkspacePack, against real trees", () => {
  it("passes a clean tree", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "a.txt"), "a");
    await mkdir(path.join(root, "sub"), { recursive: true });
    await writeFile(path.join(root, "sub", "b.txt"), "b");

    const result = await rehearseWorkspacePack({ localDir: root });
    expect(result).toMatchObject({ ok: true, exitCode: 0, stderr: "", faultPaths: [] });
  });

  it("fails on a file it may not read, and names it", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "secret.bin"), "x");
    await chmod(path.join(root, "secret.bin"), 0o000);

    const result = await rehearseWorkspacePack({ localDir: root });
    expect(result.ok).toBe(false);
    expect(result.faultPaths.join(" ")).toContain("secret.bin");
  });

  it("fails on a directory it may not enter, and names it", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "locked", "inner"), { recursive: true });
    await writeFile(path.join(root, "locked", "inner", "f"), "f");
    await chmod(path.join(root, "locked"), 0o000);

    const result = await rehearseWorkspacePack({ localDir: root });
    expect(result.ok).toBe(false);
    expect(result.faultPaths.join(" ")).toContain("locked");
  });

  // The fix this change dropped. A symlink scan would have exited 2 here and
  // blocked a transfer that succeeds, while staying silent on the two cases
  // above, which are the ones that abort.
  it("passes a dangling symlink, with and without following symlinks", async () => {
    const root = await makeRoot();
    await symlink("/nonexistent/deleted-temp-dir/skills", path.join(root, "dead"));
    await writeFile(path.join(root, "real.txt"), "r");

    expect(await rehearseWorkspacePack({ localDir: root })).toMatchObject({ ok: true });
    expect(
      await rehearseWorkspacePack({ localDir: root, followSymlinks: true }),
    ).toMatchObject({ ok: true });
  });

  // Why the caller must compute excludes first and rehearse the payload, not
  // the directory as it sits: a fault inside an excluded path is not a fault.
  it("passes when the offending path is excluded from the transfer", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "keep.txt"), "k");
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "blob"), "b");
    await chmod(path.join(root, "node_modules"), 0o000);

    expect(await rehearseWorkspacePack({ localDir: root })).toMatchObject({ ok: false });
    expect(
      await rehearseWorkspacePack({ localDir: root, exclude: ["node_modules"] }),
    ).toMatchObject({ ok: true, faultPaths: [] });
  });

  it("reports a rehearsal that could not run as a failure, never as a pass", async () => {
    const root = await makeRoot();
    const result = await rehearseWorkspacePack({ localDir: path.join(root, "absent") });
    expect(result.ok).toBe(false);
  });
});

describe("requirePackableWorkspace", () => {
  it("throws a non-retryable error naming the path, and says so in the message", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "unreadable"), "x");
    await chmod(path.join(root, "unreadable"), 0o000);

    const error = await requirePackableWorkspace({ localDir: root }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(isWorkspaceUnshippableError(error)).toBe(true);
    const unshippable = error as WorkspaceUnshippableError;
    expect(unshippable.retryable).toBe(false);
    expect(unshippable.stage).toBe("workspace_pack_rehearsal");
    expect(unshippable.message).toContain("cannot be packed");
    expect(unshippable.message).toContain("will not be retried");
    expect(unshippable.message).toContain("unreadable");
  });

  it("returns quietly for a clean tree", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "a"), "a");
    await expect(requirePackableWorkspace({ localDir: root })).resolves.toBeUndefined();
  });
});

describe("stripSshNoise", () => {
  it("drops the banner that made three healthy boxes look sick", () => {
    const stderr = [
      "Warning: Permanently added 'code-at-gona-be.boxes' (ED25519) to the list of known hosts.",
      "tar: ./.scratch/kul75/pc/.claude/skills/paperclip: Cannot open: Permission denied",
      "tar: Exiting with failure status due to previous errors",
    ].join("\n");

    const stripped = stripSshNoise(stderr);
    expect(stripped).not.toContain("known hosts");
    expect(stripped).toContain("Cannot open: Permission denied");
  });

  it("returns empty when the banner was the whole output", () => {
    expect(
      stripSshNoise("Warning: Permanently added 'h' (ED25519) to the list of known hosts.\n"),
    ).toBe("");
  });

  it("keeps a real transport error word for word", () => {
    const real = "ssh: connect to host h port 22: Connection refused";
    expect(stripSshNoise(`Warning: Permanently added 'h' to the list of known hosts.\n${real}`)).toBe(real);
  });
});

describe("parseTarFaultPaths", () => {
  it("reads the literal line from the outage", () => {
    expect(
      parseTarFaultPaths(
        "tar: ./.scratch/kul75/pc/.claude/skills/paperclip: Cannot open: Permission denied\n" +
          "tar: Exiting with failure status due to previous errors",
      ),
    ).toEqual(["./.scratch/kul75/pc/.claude/skills/paperclip"]);
  });

  it("reads the Mac packer's different wording for the same fault", () => {
    expect(parseTarFaultPaths("tar: Can't open `secret.bin': Permission denied")).toEqual([
      "secret.bin",
    ]);
    expect(
      parseTarFaultPaths("tar: ./locked: Couldn't visit directory: Permission denied"),
    ).toEqual(["./locked"]);
  });

  it("reports no path for tar's summary lines", () => {
    expect(parseTarFaultPaths("tar: Error exit delayed from previous errors.")).toEqual([]);
    expect(
      parseTarFaultPaths("tar: Exiting with failure status due to previous errors"),
    ).toEqual([]);
  });

  it("keeps a path that contains a colon", () => {
    expect(parseTarFaultPaths("tar: ./odd:name/f: Cannot open: Permission denied")).toEqual([
      "./odd:name/f",
    ]);
  });

  it("does not repeat a path tar named twice", () => {
    expect(
      parseTarFaultPaths(
        "tar: ./a: Cannot open: Permission denied\ntar: ./a: Cannot open: Permission denied",
      ),
    ).toEqual(["./a"]);
  });

  it("tells a tar diagnostic from a transport error", () => {
    expect(isTarDiagnostic("tar: ./a: Cannot open: Permission denied")).toBe(true);
    expect(isTarDiagnostic("ssh: connect to host h port 22: Connection refused")).toBe(false);
    expect(isTarDiagnostic("")).toBe(false);
  });
});

describe("classifyTransferFailure", () => {
  it("calls a local pack fault unshippable and refuses the retry", () => {
    const error = classifyTransferFailure({
      stage: "workspace_upload",
      localDir: "/w",
      remoteDir: "/r",
      tarStderr: "tar: ./locked: Couldn't visit directory: Permission denied",
      sshStderr: "",
      tarExitCode: 1,
      sshExitCode: 0,
    });

    expect(isWorkspaceUnshippableError(error)).toBe(true);
    expect((error as WorkspaceUnshippableError).retryable).toBe(false);
    expect((error as WorkspaceUnshippableError).faultPaths).toEqual(["./locked"]);
    expect(error.message).toContain("workspace_upload");
  });

  // The day of the outage: the far end's packer died, its words came back over
  // the connection, and the banner in front of them named a healthy box.
  it("calls the far end's pack fault unshippable, and does not lead with the host", () => {
    const error = classifyTransferFailure({
      stage: "workspace_upload",
      localDir: "/w",
      remoteDir: "/r",
      tarStderr: "",
      sshStderr: [
        "Warning: Permanently added 'code-at-gona-be.boxes' (ED25519) to the list of known hosts.",
        "tar: ./.scratch/kul75/pc/.claude/skills/paperclip: Cannot open: Permission denied",
        "tar: Exiting with failure status due to previous errors",
      ].join("\n"),
      tarExitCode: 0,
      sshExitCode: 2,
    });

    expect(isWorkspaceUnshippableError(error)).toBe(true);
    expect((error as WorkspaceUnshippableError).retryable).toBe(false);
    expect((error as WorkspaceUnshippableError).faultPaths).toEqual([
      "./.scratch/kul75/pc/.claude/skills/paperclip",
    ]);
    expect(error.message).not.toContain("known hosts");
    expect(error.message.split("\n")[0]).toContain("could not receive the workspace");
  });

  it("leaves a genuine transport failure retryable, and names the step", () => {
    const error = classifyTransferFailure({
      stage: "asset_upload",
      remoteDir: "/r",
      tarStderr: "",
      sshStderr:
        "Warning: Permanently added 'h' to the list of known hosts.\nssh: connect to host h port 22: Connection refused",
      tarExitCode: 0,
      sshExitCode: 255,
    });

    expect(isWorkspaceUnshippableError(error)).toBe(false);
    expect(error.message).toContain("asset_upload");
    expect(error.message).toContain("Connection refused");
    expect(error.message).not.toContain("known hosts");
  });

  // Two steps that used to fail identically with no label, which is why the
  // outage's own logs cannot say which one failed.
  it("distinguishes two steps that otherwise fail identically", () => {
    const shared = {
      tarStderr: "",
      sshStderr: "ssh: connect to host h port 22: Connection refused",
      tarExitCode: 0,
      sshExitCode: 255,
    };
    const upload = classifyTransferFailure({ ...shared, stage: "workspace_upload" });
    const download = classifyTransferFailure({ ...shared, stage: "workspace_download" });
    expect(upload.message).not.toBe(download.message);
    expect(upload.message).toContain("workspace_upload");
    expect(download.message).toContain("workspace_download");
  });

  it("caps the reported paths and counts the rest", () => {
    const stderr = Array.from(
      { length: 25 },
      (_unused, index) => `tar: ./p${index}: Cannot open: Permission denied`,
    ).join("\n");
    const error = classifyTransferFailure({
      stage: "workspace_upload",
      tarStderr: stderr,
      sshStderr: "",
      tarExitCode: 1,
      sshExitCode: 0,
    });
    expect((error as WorkspaceUnshippableError).faultPaths).toHaveLength(25);
    expect(error.message).toContain("and 15 more");
  });
});

describe("the far-end destination rehearsal, run by a real shell", () => {
  const shells = ["sh", "bash", "zsh"] as const;

  async function runPrecheck(shell: string, remoteDir: string) {
    const script = buildRemoteDestinationPrecheckScript({ remoteDir, quote: shellQuote });
    const { stdout } = await execFileAsync(shell, ["-c", script], { maxBuffer: 4 * 1024 * 1024 });
    return { stdout, faults: parseRemoteDestinationPrecheckOutput(stdout) };
  }

  for (const shell of shells) {
    it(`passes a sound destination under ${shell}`, async () => {
      const root = await makeRoot();
      const dest = path.join(root, "runtime", "workspace");
      await mkdir(path.join(dest, "sub"), { recursive: true });
      await writeFile(path.join(dest, "sub", "f"), "f");

      const { stdout, faults } = await runPrecheck(shell, dest);
      expect(stdout).toContain(REMOTE_DESTINATION_OK_MARKER);
      expect(faults).toEqual([]);
    });

    // The fault shape that survives the clearing step. Measured directly:
    // `rm -rf` on a mode-000 non-empty directory exits 1 with
    // "rm: dest/locked: Permission denied" / "rm: dest: Directory not empty",
    // so the stale entry stays and the extraction that follows dies on it.
    it(`names a stale directory the extraction could not write into, under ${shell}`, async () => {
      const root = await makeRoot();
      const dest = path.join(root, "workspace");
      await mkdir(path.join(dest, ".scratch", "kul75"), { recursive: true });
      await writeFile(path.join(dest, ".scratch", "kul75", "f"), "f");
      await chmod(path.join(dest, ".scratch", "kul75"), 0o000);

      const { faults } = await runPrecheck(shell, dest);
      expect(faults).not.toBeNull();
      expect(faults?.join(" ")).toContain(path.join(dest, ".scratch", "kul75"));
    });

    it(`names a stale file the extraction could not overwrite, under ${shell}`, async () => {
      const root = await makeRoot();
      const dest = path.join(root, "workspace");
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, "readonly.txt"), "x");
      await chmod(path.join(dest, "readonly.txt"), 0o444);

      const { faults } = await runPrecheck(shell, dest);
      expect(faults?.join(" ")).toContain(path.join(dest, "readonly.txt"));
    });

    it(`creates a destination that is not there yet, under ${shell}`, async () => {
      const root = await makeRoot();
      const dest = path.join(root, "runtime", "fresh");

      const { faults } = await runPrecheck(shell, dest);
      expect(faults).toEqual([]);
    });

    it(`names the parent when the destination cannot be created, under ${shell}`, async () => {
      const root = await makeRoot();
      const parent = path.join(root, "sealed");
      await mkdir(parent, { recursive: true });
      await chmod(parent, 0o500);

      const { faults } = await runPrecheck(shell, path.join(parent, "workspace"));
      expect(faults?.join(" ")).toContain(parent);
    });

    it(`names a destination that is a file rather than a directory, under ${shell}`, async () => {
      const root = await makeRoot();
      const dest = path.join(root, "notadir");
      await writeFile(dest, "x");

      const { faults } = await runPrecheck(shell, dest);
      expect(faults).toEqual([dest]);
    });

    // The issue asks the transfer to refuse *or repair and proceed*.
    it(`repairs what it named, then passes, under ${shell}`, async () => {
      const root = await makeRoot();
      const dest = path.join(root, "workspace");
      await mkdir(path.join(dest, "locked"), { recursive: true });
      await writeFile(path.join(dest, "locked", "f"), "f");
      await writeFile(path.join(dest, "readonly.txt"), "x");
      await chmod(path.join(dest, "readonly.txt"), 0o444);
      await chmod(path.join(dest, "locked"), 0o000);

      const first = await runPrecheck(shell, dest);
      expect(first.faults?.length).toBeGreaterThan(0);

      const repair = buildRemoteDestinationRepairScript({
        faultPaths: first.faults ?? [],
        quote: shellQuote,
      });
      await execFileAsync(shell, ["-c", repair]);

      expect((await runPrecheck(shell, dest)).faults).toEqual([]);
    });

    it(`survives a path with a space and a quote, under ${shell}`, async () => {
      const root = await makeRoot();
      const dest = path.join(root, "work space's dir");
      await mkdir(path.join(dest, "locked"), { recursive: true });
      await writeFile(path.join(dest, "locked", "f"), "f");
      await chmod(path.join(dest, "locked"), 0o000);

      const { faults } = await runPrecheck(shell, dest);
      expect(faults?.join(" ")).toContain(path.join(dest, "locked"));
    });
  }

  it("repairs nothing when nothing was named", async () => {
    const script = buildRemoteDestinationRepairScript({ faultPaths: [], quote: shellQuote });
    await expect(execFileAsync("sh", ["-c", script])).resolves.toBeTruthy();
  });
});

describe("parseRemoteDestinationPrecheckOutput", () => {
  // The defect this whole change replaces was a gate that answered yes to
  // every question. Output with no OK marker is unproven, never clean.
  it("returns null when the OK marker is absent", () => {
    expect(parseRemoteDestinationPrecheckOutput("")).toBeNull();
    expect(parseRemoteDestinationPrecheckOutput("some truncated out")).toBeNull();
    expect(
      parseRemoteDestinationPrecheckOutput(`${REMOTE_DESTINATION_FAULT_MARKER} /r/a`),
    ).toBeNull();
  });

  it("returns the named paths when the marker is present", () => {
    expect(
      parseRemoteDestinationPrecheckOutput(
        [
          `${REMOTE_DESTINATION_FAULT_MARKER} /r/a`,
          `${REMOTE_DESTINATION_FAULT_MARKER} /r/b`,
          `${REMOTE_DESTINATION_FAULT_MARKER} /r/a`,
          REMOTE_DESTINATION_OK_MARKER,
        ].join("\n"),
      ),
    ).toEqual(["/r/a", "/r/b"]);
  });

  it("returns an empty list, not null, for a clean destination", () => {
    expect(parseRemoteDestinationPrecheckOutput(`${REMOTE_DESTINATION_OK_MARKER}\n`)).toEqual([]);
  });
});

describe("assertPlainAbsoluteRemoteDir", () => {
  it("accepts a plain absolute directory", () => {
    expect(assertPlainAbsoluteRemoteDir(" /home/u/runtime/ws ")).toBe("/home/u/runtime/ws");
  });

  it.each(["", "relative/dir", "/", "/home/../etc", "  "])("refuses %j", (value) => {
    expect(() => assertPlainAbsoluteRemoteDir(value)).toThrow(/plain absolute directory/);
  });
});

describe("the non-retryable verdict survives the package boundary", () => {
  it("recognises the error thrown here", () => {
    const error = new WorkspaceUnshippableError({
      stage: "workspace_upload",
      summary: "unshippable",
      faultPaths: ["./locked"],
      toolStderr: "tar: ./locked: Cannot open: Permission denied",
    });
    expect(isWorkspaceUnshippableError(error)).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("recognises a copy from another realm, where instanceof answers false", () => {
    // What the server receives under a bundler or a duplicated install: the
    // same error, carrying the same verdict, but not an instance of the class
    // this file holds. `instanceof` alone would call it retryable and re-send
    // the identical bytes -- a gate failing open, which is the defect this
    // module exists to remove.
    const foreign = Object.assign(new Error("unshippable (workspace_upload); this will not be retried."), {
      name: "WorkspaceUnshippableError",
      retryable: false as const,
      stage: "workspace_upload" as const,
      faultPaths: ["./locked"],
      toolStderr: "",
      exitCode: 2,
    });
    expect(foreign instanceof WorkspaceUnshippableError).toBe(false);
    expect(isWorkspaceUnshippableError(foreign)).toBe(true);
  });

  it.each([
    ["a transport error, which a retry can help", new Error("workspace_upload: ssh exited with code 255")],
    ["a lookalike carrying no verdict", Object.assign(new Error("x"), { name: "WorkspaceUnshippableError" })],
    ["a lookalike claiming to be retryable", Object.assign(new Error("x"), {
      name: "WorkspaceUnshippableError", retryable: true, faultPaths: [],
    })],
    ["a plain object, not an error at all", { name: "WorkspaceUnshippableError", retryable: false, faultPaths: [] }],
  ])("refuses %s", (_label, value) => {
    expect(isWorkspaceUnshippableError(value)).toBe(false);
  });
});

// The defect that caused the outage this module answers was a name advertised
// with nothing behind it: a gate whose own help listed `preflight`, whose
// argument parser accepted it, and whose dispatch had no branch for it, so it
// answered "shippable" to every question. A declared stage that no transfer
// ever emits is the same shape -- a label the logs promise and never carry --
// so the list is checked against the source rather than against memory.
describe("every declared transfer stage is one a transfer can actually emit", () => {
  it("finds each stage name used in ssh.ts or remote-managed-runtime.ts", async () => {
    const sources = await Promise.all(
      ["ssh.ts", "remote-managed-runtime.ts"].map((file) =>
        readFile(path.join(import.meta.dirname, file), "utf8"),
      ),
    );
    const emitted = sources.join("\n");
    const unemitted = WORKSPACE_TRANSFER_STAGES.filter(
      (stage) => !emitted.includes(`"${stage}"`),
    );
    expect(unemitted).toEqual([]);
  });

  it("fails when a stage is declared and never emitted", () => {
    // Proof the check above has teeth: the same comparison against a source
    // that emits only one of the stages must name the rest.
    const emitted = '{ stage: "workspace_upload" }';
    const unemitted = WORKSPACE_TRANSFER_STAGES.filter(
      (stage) => !emitted.includes(`"${stage}"`),
    );
    expect(unemitted.length).toBe(WORKSPACE_TRANSFER_STAGES.length - 1);
    expect(unemitted).toContain("workspace_pack_rehearsal");
  });
});
