import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPreviewSourceClean, previewIdentity } from "./build-preview-migrator.mjs";

test("preview source identity permits CI lock resolution but rejects staged and unstaged source drift", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "preview-source-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  try {
    git("init");
    for (const file of ["pnpm-lock.yaml", "package.json"]) writeFileSync(path.join(repo, file), "initial\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
    assertPreviewSourceClean(repo);
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "CI resolved\n");
    assertPreviewSourceClean(repo);
    writeFileSync(path.join(repo, "package.json"), "source drift\n");
    assert.throws(() => assertPreviewSourceClean(repo));
    git("add", "package.json");
    assert.throws(() => assertPreviewSourceClean(repo));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("preview artifact identity is immutable, namespaced, and ordered by commit time", () => {
  const sha = "2f42a4968d5761fd62172e35ecf8188195b8d431";
  const identity = previewIdentity(sha, new Date("2026-07-19T09:30:00.000Z"), "https://staging.example/migrators");
  assert.equal(identity.version, `2026.719.34201-preview.sha${sha}`);
  assert.equal(identity.tag, `preview/${sha}`);
  assert.equal(identity.baseUrl, `https://staging.example/migrators/${sha}`);
  assert.throws(() => previewIdentity("master", new Date()), /Invalid preview/);
  assert.throws(() => previewIdentity(sha, new Date("invalid")), /Invalid preview/);
});

test("staging artifact URLs cannot carry credentials or use plaintext", () => {
  for (const url of ["http://staging.example", "https://user:secret@staging.example", "https://staging.example?token=secret"]) {
    assert.throws(() => previewIdentity("a".repeat(40), new Date(), url), /Invalid staging/);
  }
});
