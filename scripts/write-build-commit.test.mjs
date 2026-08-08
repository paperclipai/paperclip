import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveBuildCommit,
  writeBuildCommitMarker,
} from "./write-build-commit.mjs";

test("resolveBuildCommit prefers explicit deployment metadata", () => {
  let gitCalled = false;

  assert.equal(
    resolveBuildCommit({
      environmentCommit: "0123456789ABCDEF0123456789ABCDEF01234567",
      gitCommand: () => {
        gitCalled = true;
        return "ffffffffffffffffffffffffffffffffffffffff";
      },
    }),
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(gitCalled, false);
});

test("writeBuildCommitMarker writes a package-local marker", () => {
  const directory = mkdtempSync(join(tmpdir(), "paperclip-build-commit-"));
  const outputPath = join(directory, "dist", ".paperclip-build-commit");

  assert.equal(
    writeBuildCommitMarker(outputPath, {
      environmentCommit: null,
      gitCommand: () => "89abcdef0123456789abcdef0123456789abcdef\n",
    }),
    "89abcdef0123456789abcdef0123456789abcdef",
  );
  assert.equal(
    readFileSync(outputPath, "utf8"),
    "89abcdef0123456789abcdef0123456789abcdef\n",
  );
});

test("writeBuildCommitMarker removes a stale marker when metadata is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "paperclip-build-commit-"));
  const outputPath = join(directory, ".paperclip-build-commit");
  writeFileSync(outputPath, "ffffffffffffffffffffffffffffffffffffffff\n", "utf8");

  assert.equal(
    writeBuildCommitMarker(outputPath, {
      environmentCommit: null,
      gitCommand: () => {
        throw new Error("git unavailable");
      },
    }),
    null,
  );
  assert.throws(() => readFileSync(outputPath, "utf8"), { code: "ENOENT" });
});
