import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { prepareRemoteOpenCodeArtifacts } from "./remote-opencode-artifacts.js";
import {
  canonicalProviderPackJson,
  type ProviderPackIdentity,
} from "./remote-provider-pack-verification.js";
import type { NativeProviderArtifactReceipt } from "./native-provider-artifacts.js";

const exec = promisify(execFile),
  homes: string[] = [];
afterEach(async () => {
  for (const root of homes.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "paperclip-closed-launch-")),
  );
  homes.push(root);
  const accountHome = join(root, "account"),
    sourceRoot = join(root, "image-provider-pack");
  await mkdir(accountHome, { mode: 0o700 });
  await mkdir(sourceRoot);
  const values = {
    nodeCommand: "\u007fELForiginal qualified Node",
    opencodeProxy: "original qualified proxy",
    opencodeExecutable: "\u007fELForiginal qualified OpenCode",
  };
  const artifacts: Record<string, { path: string; sha256: string }> = {};
  for (const [name, value] of Object.entries(values)) {
    const path = `qualified/${name}`;
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), value, { mode: 0o500 });
    artifacts[name] = {
      path,
      sha256: `sha256:${createHash("sha256").update(value).digest("hex")}`,
    };
  }
  const payload = {
    artifacts,
    target: { platform: "linux", architecture: "x64" },
    pins: { opencode: "1.18.34" },
    runnerSourceRevision: "a".repeat(40),
  };
  const manifest = {
    schema: "paperclip-runner/remote-provider-pack/v1",
    payload,
    digest: `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}`,
  } as ProviderPackIdentity;
  let activeHome = accountHome;
  const runner = {
    execute: async (input) => {
      const result = input.args?.[1]?.startsWith("const os=require")
        ? {
            stdout: JSON.stringify({ home: activeHome, uid: userInfo().uid }),
            stderr: "",
          }
        : await exec(input.command, input.args ?? []).catch((error) => ({
            stdout: error.stdout ?? "",
            stderr: error.stderr ?? "",
            code: error.code,
          }));
      return {
        ...result,
        exitCode: "code" in result ? 1 : 0,
        signal: null,
        timedOut: false,
      };
    },
  } as CommandManagedRuntimeRunner;
  const stageFile = async (file: {
    sourcePath: string;
    targetPath: string;
  }) => {
    await cp(file.sourcePath, file.targetPath, {
      errorOnExist: true,
      force: false,
    });
  };
  return {
    root,
    accountHome,
    sourceRoot,
    values,
    manifest,
    runner,
    stageFile,
    changeAccount: (home: string) => {
      activeHome = home;
    },
  };
}
it("restores exact launch paths independently of a replacement lease cwd and upgraded image", async () => {
  const f = await fixture();
  const first = await prepareRemoteOpenCodeArtifacts({
    ...f,
    bootstrapNode: process.execPath,
    nonce: randomUUID(),
  });
  const cache = join(f.root, "decrypted-backup");
  await mkdir(cache);
  for (const [name, path] of Object.entries(first.paths))
    await cp(path, join(cache, name));
  const receipt = {
    launchRoot: first.root,
    accountUid: userInfo().uid,
    providerPackDigest: f.manifest.digest,
  } as NativeProviderArtifactReceipt;
  const oldCwd = join(f.root, "workspace-old-lease"),
    newCwd = join(f.root, "workspace-new-lease");
  await mkdir(oldCwd);
  await mkdir(newCwd);
  await rm(oldCwd, { recursive: true });
  await rm(first.root, { recursive: true });
  await rm(f.sourceRoot, { recursive: true });
  await mkdir(f.sourceRoot);
  await writeFile(join(f.sourceRoot, "new-proxy"), "upgraded image proxy");
  const recovered = await prepareRemoteOpenCodeArtifacts({
    ...f,
    sourceRoot: undefined,
    restored: { receipt, directory: cache },
    bootstrapNode: process.execPath,
    nonce: randomUUID(),
  });
  expect(recovered).toEqual(first);
  for (const [name, value] of Object.entries(f.values))
    expect(
      await readFile(
        recovered.paths[name as keyof typeof recovered.paths],
        "utf8",
      ),
    ).toBe(value);
  expect(await readFile(join(f.sourceRoot, "new-proxy"), "utf8")).toBe(
    "upgraded image proxy",
  );
});
it("refuses a different account instead of rewriting the recorded profile path", async () => {
  const f = await fixture(),
    first = await prepareRemoteOpenCodeArtifacts({
      ...f,
      bootstrapNode: process.execPath,
      nonce: randomUUID(),
    });
  const next = join(f.root, "other-account");
  await mkdir(next, { mode: 0o700 });
  f.changeAccount(next);
  await expect(
    prepareRemoteOpenCodeArtifacts({
      ...f,
      bootstrapNode: process.execPath,
      nonce: randomUUID(),
      restored: {
        receipt: {
          launchRoot: first.root,
          accountUid: userInfo().uid,
          providerPackDigest: f.manifest.digest,
        } as NativeProviderArtifactReceipt,
        directory: f.sourceRoot,
      },
    }),
  ).rejects.toThrow("account_changed");
});
it("rejects another account UID even when its absolute home path is unchanged", async () => {
  const f = await fixture(),
    first = await prepareRemoteOpenCodeArtifacts({
      ...f,
      bootstrapNode: process.execPath,
      nonce: randomUUID(),
    });
  await expect(
    prepareRemoteOpenCodeArtifacts({
      ...f,
      bootstrapNode: process.execPath,
      nonce: randomUUID(),
      restored: {
        receipt: {
          launchRoot: first.root,
          providerPackDigest: f.manifest.digest,
          accountUid: userInfo().uid + 1,
        } as unknown as NativeProviderArtifactReceipt,
        directory: f.sourceRoot,
      },
    }),
  ).rejects.toThrow("account_changed");
});
it("materializes qualified internal package links as regular closed launch files", async () => {
  const f = await fixture();
  await rename(
    join(f.sourceRoot, "qualified"),
    join(f.sourceRoot, "package-content"),
  );
  await symlink("package-content", join(f.sourceRoot, "qualified"));
  const launch = await prepareRemoteOpenCodeArtifacts({
    ...f,
    bootstrapNode: process.execPath,
    nonce: randomUUID(),
  });
  for (const [name, path] of Object.entries(launch.paths)) {
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(path, "utf8")).toBe(
      f.values[name as keyof typeof f.values],
    );
  }
});
it("holds a corrupted retained closure and never replaces it behind provider state", async () => {
  const f = await fixture(),
    first = await prepareRemoteOpenCodeArtifacts({
      ...f,
      bootstrapNode: process.execPath,
      nonce: randomUUID(),
    });
  await chmod(first.paths.opencodeProxy, 0o700);
  await writeFile(first.paths.opencodeProxy, "changed proxy bytes");
  await expect(
    prepareRemoteOpenCodeArtifacts({
      ...f,
      bootstrapNode: process.execPath,
      nonce: randomUUID(),
    }),
  ).rejects.toThrow("remote_unavailable");
  expect(await readFile(first.paths.opencodeProxy, "utf8")).toBe(
    "changed proxy bytes",
  );
});
it("rejects administrative symlinks and source hash drift before publication", async () => {
  const f = await fixture(),
    source = join(
      f.sourceRoot,
      f.manifest.payload.artifacts.opencodeProxy.path,
    );
  const outside = join(f.root, "outside");
  await cp(source, outside);
  await rm(source);
  await symlink(outside, source);
  await expect(
    prepareRemoteOpenCodeArtifacts({
      ...f,
      bootstrapNode: process.execPath,
      nonce: randomUUID(),
    }),
  ).rejects.toThrow("remote_unavailable");
  await rm(source);
  await writeFile(source, "different source bytes");
  await expect(
    prepareRemoteOpenCodeArtifacts({
      ...f,
      bootstrapNode: process.execPath,
      nonce: randomUUID(),
    }),
  ).rejects.toThrow("remote_unavailable");
  expect(
    await readdir(
      join(
        f.accountHome,
        ".paperclip-runtime/paperclip-runner/provider-artifacts",
      ),
    ),
  ).toEqual([]);
});
