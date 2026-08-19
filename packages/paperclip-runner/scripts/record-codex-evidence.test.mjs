import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertCodexTraceReadyForOutputs,
  createCodexDeniedHostPaths,
  findReadableCodexCredentialFiles,
  readRequiredCodexOutput,
} from "./lib/codex-evidence.mjs";

test("a warmed Codex home contributes credential files, not the readable Codex directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-codex-recorder-test-"));
  try {
    const hostHome = join(root, "home");
    const codexHome = join(hostHome, ".codex");
    const memories = join(codexHome, "memories");
    const auth = join(codexHome, "auth.json");
    const config = join(codexHome, "config.toml");
    const unrelatedSecretPath = join(root, "secret.txt");
    await mkdir(memories, { recursive: true });
    await writeFile(auth, "auth");
    await writeFile(config, "config");
    await writeFile(unrelatedSecretPath, "secret");

    const credentialFiles = await findReadableCodexCredentialFiles(codexHome);
    assert.deepEqual(credentialFiles, [auth, config]);

    const deniedPaths = createCodexDeniedHostPaths({
      hostHome,
      codexCredentialFiles: credentialFiles,
      unrelatedSecretPath,
    });
    assert.deepEqual(deniedPaths, [hostHome, auth, config, unrelatedSecretPath]);
    assert.equal(deniedPaths.includes(codexHome), false);
    assert.equal(deniedPaths.includes(memories), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-done trace fails before the recorder reads workspace outputs", () => {
  assert.throws(
    () => assertCodexTraceReadyForOutputs({
      resultDecision: { status: "accepted", issues: [] },
      result: {
        reportedWorkDisposition: "blocked",
        summary: "The required isolation command failed.",
      },
      assertions: { proposalAccepted: true },
    }),
    /requires an accepted `done` result.*disposition=blocked.*Expected workspace outputs were not read/,
  );
});

test("a missing accepted-result output has a named recorder diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-codex-recorder-test-"));
  try {
    await assert.rejects(
      readRequiredCodexOutput(join(root, "hello.txt"), "hello.txt"),
      (error) => {
        assert.equal(
          error.message,
          "Codex recorder expected hello.txt after an accepted `done` result, but the file was not created.",
        );
        assert.doesNotMatch(error.message, /ENOENT/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
