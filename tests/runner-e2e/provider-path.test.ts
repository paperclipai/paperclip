import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, chmod, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareProviderPath, writeProviderPathProvenance } from "./provider-path.js";

const temporaryRoots: string[] = [];

async function fixtureExecutable(contents = "#!/bin/sh\nexit 0\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-e2e-provider-path-"));
  temporaryRoots.push(root);
  const executable = path.join(root, "codex");
  await writeFile(executable, contents, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runner E2E provider executable selection", () => {
  it("uses and hashes the injected pinned dependency by default", async () => {
    const { root, executable } = await fixtureExecutable();
    const temporaryRoot = path.join(root, "attempt");
    const resolvedExecutable = await realpath(executable);
    const selection = await prepareProviderPath({
      temporaryRoot,
      inheritedPath: "/usr/bin",
      resolvePinnedExecutable: async () => executable,
    });

    expect(selection.provenance).toEqual({
      selectedOrigin: "pinned_dependency",
      resolvedPath: resolvedExecutable,
      entrypointSha256: createHash("sha256").update("#!/bin/sh\nexit 0\n").digest("hex"),
      providerNativeVersion: "not_probed",
    });
    expect(selection.path.split(path.delimiter)).toEqual([
      path.join(temporaryRoot, "provider-bin"),
      "/usr/bin",
    ]);
  });

  it("uses an explicit absolute executable without resolving the pinned default", async () => {
    const { root, executable } = await fixtureExecutable("#!/bin/sh\necho selected\n");
    const resolvedExecutable = await realpath(executable);
    let defaultResolverCalled = false;
    const selection = await prepareProviderPath({
      temporaryRoot: path.join(root, "attempt"),
      inheritedPath: undefined,
      explicitOverride: executable,
      resolvePinnedExecutable: async () => {
        defaultResolverCalled = true;
        throw new Error("default should not be used");
      },
    });
    expect(defaultResolverCalled).toBe(false);
    expect(selection.provenance.selectedOrigin).toBe("explicit_override");
    expect(selection.provenance.resolvedPath).toBe(resolvedExecutable);

    const provenancePath = path.join(root, "attempt", "provider-provenance.json");
    await mkdir(path.dirname(provenancePath), { recursive: true });
    await writeProviderPathProvenance(provenancePath, selection.provenance);
    expect(JSON.parse(await readFile(provenancePath, "utf8"))).toEqual(selection.provenance);
    expect((await stat(provenancePath)).mode & 0o777).toBe(0o600);
  });

  it("rejects relative, missing, and non-executable overrides", async () => {
    const { root } = await fixtureExecutable();
    const temporaryRoot = path.join(root, "attempt");
    const resolver = async () => {
      throw new Error("pinned resolver should not be called");
    };
    await expect(
      prepareProviderPath({ temporaryRoot, inheritedPath: undefined, explicitOverride: "./codex", resolvePinnedExecutable: resolver }),
    ).rejects.toThrow("must be an absolute path");
    await expect(
      prepareProviderPath({ temporaryRoot, inheritedPath: undefined, explicitOverride: path.join(root, "missing"), resolvePinnedExecutable: resolver }),
    ).rejects.toThrow("does not exist");

    const nonExecutable = path.join(root, "not-executable");
    await writeFile(nonExecutable, "text\n", { mode: 0o600 });
    await chmod(nonExecutable, 0o600);
    await expect(
      prepareProviderPath({ temporaryRoot, inheritedPath: undefined, explicitOverride: nonExecutable, resolvePinnedExecutable: resolver }),
    ).rejects.toThrow("is not executable");
  });
});
