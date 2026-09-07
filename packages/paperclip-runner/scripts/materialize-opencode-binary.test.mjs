import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { materializePinnedOpenCodeBinary } from "./materialize-opencode-binary.mjs";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-binary-"));
  temporaryDirectories.push(root);
  const packageRoot = join(root, "opencode-ai");
  const baselineRoot = join(root, "opencode-linux-x64-baseline");
  await Promise.all([
    mkdir(join(packageRoot, "bin"), { recursive: true }),
    mkdir(join(baselineRoot, "bin"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "opencode-ai",
        version: options.packageVersion ?? "1.18.17",
      }),
    ),
    writeFile(
      join(baselineRoot, "package.json"),
      JSON.stringify({
        name: "opencode-linux-x64-baseline",
        version: options.baselineVersion ?? "1.18.17",
      }),
    ),
    writeFile(join(packageRoot, "bin", "opencode.exe"), "sentinel\n"),
  ]);
  const source = join(baselineRoot, "bin", "opencode");
  if (options.symlinkSource) {
    const realSource = join(root, "real-opencode");
    await writeFile(realSource, "#!/bin/sh\necho 1.18.17\n");
    await chmod(realSource, 0o755);
    await symlink(realSource, source);
  } else {
    await writeFile(source, "#!/bin/sh\necho 1.18.17\n");
    await chmod(source, 0o755);
  }
  return packageRoot;
}

test("materializes the pinned baseline executable with a verified version", async () => {
  const packageRoot = await fixture();
  const result = materializePinnedOpenCodeBinary({
    packageRoot,
    platform: "linux",
    architecture: "x64",
  });
  assert.equal(result.version, "1.18.17");
  assert.match(result.sourceDigest, /^[0-9a-f]{64}$/);
});

test("refuses version, file-type, and platform drift", async () => {
  const wrongVersion = await fixture({ baselineVersion: "1.18.18" });
  assert.throws(
    () =>
      materializePinnedOpenCodeBinary({
        packageRoot: wrongVersion,
        platform: "linux",
        architecture: "x64",
      }),
    /Expected opencode-linux-x64-baseline@1\.18\.17/,
  );

  const symlinkSource = await fixture({ symlinkSource: true });
  assert.throws(
    () =>
      materializePinnedOpenCodeBinary({
        packageRoot: symlinkSource,
        platform: "linux",
        architecture: "x64",
      }),
    /source executable is not a regular file/,
  );

  const unsupported = await fixture();
  assert.throws(
    () =>
      materializePinnedOpenCodeBinary({
        packageRoot: unsupported,
        platform: "darwin",
        architecture: "arm64",
      }),
    /requires linux\/x64/,
  );
});
