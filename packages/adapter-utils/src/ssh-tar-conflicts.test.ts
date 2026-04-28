import { describe, expect, it } from "vitest";
import { extractTarConflictPaths, WorkspaceImportConflictError } from "./ssh.js";

// Pure-Node coverage for the BLO-1497 conflict parser. The fixture-backed
// path tests in ssh-fixture.test.ts skip when sshd is unavailable, so this
// file pins the stderr signatures we promise to extract.
describe("extractTarConflictPaths", () => {
  it("extracts the BLO-1497 production failure signature", () => {
    const stderr =
      "tar: ./release-eng-tmp/magma-blo-1475/orc8r/cloud/go/serde/doc.go: Cannot open: File exists\n" +
      "tar: Exiting with failure status due to previous errors\n";
    expect(extractTarConflictPaths(stderr)).toEqual([
      "release-eng-tmp/magma-blo-1475/orc8r/cloud/go/serde/doc.go",
    ]);
  });

  it("collects multiple distinct conflict paths and trims the leading ./", () => {
    const stderr = [
      "tar: ./a/b.txt: Cannot open: File exists",
      "tar: ./a/b.txt: Cannot open: File exists.",
      "tar: ./other/dir: Cannot create directory: Not a directory",
      "tar: ./symlinked: Cannot create symlink to '../target': File exists",
    ].join("\n");
    expect(extractTarConflictPaths(stderr).sort()).toEqual([
      "a/b.txt",
      "other/dir",
      "symlinked",
    ]);
  });

  it("captures dir-blocking-file conflicts (BLO-1497 acceptance scenario 2)", () => {
    const stderr = [
      "tar: ./conflict: Cannot open: Is a directory",
      "tar: Exiting with failure status due to previous errors",
    ].join("\n");
    expect(extractTarConflictPaths(stderr)).toEqual(["conflict"]);
  });

  it("returns an empty list for unrelated stderr", () => {
    expect(
      extractTarConflictPaths("ssh: connect to host nope port 22: Connection refused\n"),
    ).toEqual([]);
    expect(extractTarConflictPaths("")).toEqual([]);
  });
});

describe("WorkspaceImportConflictError", () => {
  it("carries the structured code and paths the orchestrator looks for", () => {
    const err = new WorkspaceImportConflictError({
      paths: ["release-eng-tmp/magma-blo-1475/foo.go", "release-eng-tmp/bar.go"],
      stderr: "tar: ...",
      remoteDir: "/srv/paperclip/workspace",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("workspace_import_conflict");
    expect(err.paths).toHaveLength(2);
    expect(err.message).toContain("/srv/paperclip/workspace");
    expect(err.message).toContain("release-eng-tmp/magma-blo-1475/foo.go");
  });

  it("summarizes large path lists without dumping every entry", () => {
    const paths = Array.from({ length: 25 }, (_, i) => `pkg/file-${i}.go`);
    const err = new WorkspaceImportConflictError({
      paths,
      stderr: "",
      remoteDir: "/remote",
    });
    expect(err.paths).toHaveLength(25);
    expect(err.message).toContain("+22 more");
  });
});
