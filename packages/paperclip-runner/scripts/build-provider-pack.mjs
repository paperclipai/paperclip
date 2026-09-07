import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const outputArgument = process.argv.slice(2).find((value) => value !== "--");
const outputRoot = resolve(
  process.cwd(),
  outputArgument ?? join(packageRoot, "provider-pack"),
);
if (
  outputRoot === workspaceRoot ||
  outputRoot === packageRoot ||
  outputRoot === "/"
) {
  throw new Error(`Refusing unsafe provider-pack output path: ${outputRoot}`);
}

const temporaryParent = mkdtempSync(join(tmpdir(), "paperclip-provider-pack-"));
const temporaryRoot = join(temporaryParent, "pack");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256File(path) {
  return `sha256:${createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")}`;
}

function sha256Tree(root) {
  const hash = createHash("sha256");
  const visit = (directory, prefix = "") => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\n`);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0${sha256File(absolutePath)}\n`);
      } else if (entry.isSymbolicLink()) {
        hash.update(
          `symlink\0${relativePath}\0${readlinkSync(absolutePath)}\n`,
        );
      } else {
        throw new Error(
          `Provider pack tree contains unsupported entry ${relativePath}`,
        );
      }
    }
  };
  visit(root);
  return `sha256:${hash.digest("hex")}`;
}

function writePortableNodeShim(name, entrypoint) {
  const shimPath = join(temporaryRoot, "node_modules", ".bin", name);
  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      "set -eu",
      'basedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      `exec "$basedir/../node/bin/node" "$basedir/../${entrypoint}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shimPath, 0o755);
}

function writePortableExecutableShim(name, executable) {
  const shimPath = join(temporaryRoot, "node_modules", ".bin", name);
  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      "set -eu",
      'basedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      `exec "$basedir/../${executable}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shimPath, 0o755);
}

try {
  const deployed = spawnSync(
    "pnpm",
    [
      "--filter",
      "@paperclipai/paperclip-runner",
      "deploy",
      "--prod",
      temporaryRoot,
    ],
    { cwd: workspaceRoot, encoding: "utf8", stdio: "inherit" },
  );
  if (deployed.status !== 0) {
    throw new Error(`pnpm deploy failed with exit code ${deployed.status}`);
  }

  // Reuse the already-qualified build interpreter instead of introducing a
  // package-manager lifecycle hook or a second binary supply chain. The pack
  // manifest binds the copied bytes, platform, architecture, and minimum
  // version before any provider is launched.
  const minimumNodeVersion = [24, 11, 0];
  const actualNodeVersion = process.versions.node.split(".").map(Number);
  if (
    actualNodeVersion[0] < minimumNodeVersion[0] ||
    (actualNodeVersion[0] === minimumNodeVersion[0] &&
      (actualNodeVersion[1] < minimumNodeVersion[1] ||
        (actualNodeVersion[1] === minimumNodeVersion[1] &&
          actualNodeVersion[2] < minimumNodeVersion[2])))
  ) {
    throw new Error("Provider pack build Node is older than 24.11.0");
  }
  const stableNodeRoot = join(temporaryRoot, "node_modules", "node");
  if (existsSync(stableNodeRoot)) {
    throw new Error(
      "Provider pack deployment unexpectedly claimed the stable Node path",
    );
  }
  const stableNodeCommand = join(stableNodeRoot, "bin", "node");
  mkdirSync(dirname(stableNodeCommand), { recursive: true, mode: 0o755 });
  copyFileSync(process.execPath, stableNodeCommand);
  chmodSync(stableNodeCommand, 0o755);

  // pnpm's generated .bin shims embed the temporary deployment directory in
  // NODE_PATH. That makes an otherwise identical provider pack hash differ on
  // every build and leaks a nonexistent host path after relocation. Replace
  // every provider-facing shim with a pack-relative launcher that always uses
  // the pinned Node executable owned by this pack.
  writePortableExecutableShim("node", "node/bin/node");
  writePortableExecutableShim("opencode", "opencode-ai/bin/opencode.exe");
  writePortableNodeShim("acpx", "acpx/dist/cli.js");
  writePortableNodeShim(
    "claude-agent-acp",
    "@agentclientprotocol/claude-agent-acp/dist/index.js",
  );
  writePortableNodeShim(
    "codex-acp",
    "@agentclientprotocol/codex-acp/dist/index.js",
  );

  // pnpm deploy may retain a workspace self-link under its virtual store. It
  // points outside the immutable pack and is not needed by the deployed
  // package, so it must not be staged or captured.
  rmSync(
    join(
      temporaryRoot,
      "node_modules",
      ".pnpm",
      "node_modules",
      "@paperclipai",
      "paperclip-runner",
    ),
    { recursive: true, force: true },
  );

  for (const shimName of readdirSync(
    join(temporaryRoot, "node_modules", ".bin"),
  )) {
    const shimPath = join(temporaryRoot, "node_modules", ".bin", shimName);
    const contents = readFileSync(shimPath, "utf8");
    if (contents.includes(temporaryParent)) {
      throw new Error(
        `Provider pack shim ${shimName} retains its temporary build path`,
      );
    }
  }

  // Exercise a clean import from the deployed dependency graph. This catches
  // malformed patch hunks that can look correct in an existing pnpm store but
  // land inside the wrong function when applied to a fresh acpx tarball.
  const acpxImport = spawnSync(
    join(temporaryRoot, "node_modules", "node", "bin", "node"),
    ["--input-type=module", "-e", 'await import("acpx/runtime")'],
    {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (acpxImport.status !== 0) {
    throw new Error(
      `Provider pack ACPX import failed: ${String(acpxImport.stderr ?? "")
        .trim()
        .slice(-2_000)}`,
    );
  }

  const opencodeProxyPath = "dist/cli/opencode-app-server-proxy.cjs";
  const acpxSidecarPath = "dist/cli/acpx-runtime-sidecar.cjs";
  const opencodeCommand = "node_modules/.bin/opencode";
  const opencodeExecutable = "node_modules/opencode-ai/bin/opencode.exe";
  const nodeCommand = "node_modules/node/bin/node";
  const productionLock = "pnpm-lock.yaml";
  copyFileSync(
    join(workspaceRoot, "pnpm-lock.yaml"),
    join(temporaryRoot, productionLock),
  );
  for (const relativePath of [
    nodeCommand,
    productionLock,
    opencodeProxyPath,
    acpxSidecarPath,
    opencodeCommand,
    opencodeExecutable,
  ]) {
    if (!existsSync(join(temporaryRoot, relativePath))) {
      throw new Error(`Provider pack is missing ${relativePath}`);
    }
  }

  const opencodeProxySha = sha256File(join(temporaryRoot, opencodeProxyPath));
  const acpxSidecarSha = sha256File(join(temporaryRoot, acpxSidecarPath));
  const distDigest = sha256Tree(join(temporaryRoot, "dist"));
  const configuredRevision =
    process.env.PAPERCLIP_RUNNER_SOURCE_REVISION?.trim();
  const revision =
    configuredRevision ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("PAPERCLIP_RUNNER_SOURCE_REVISION must be a full Git SHA");
  }
  const dirty = configuredRevision
    ? false
    : spawnSync("git", ["diff", "--quiet", "--", "packages/paperclip-runner"], {
        cwd: workspaceRoot,
      }).status !== 0;
  const payload = {
    pins: {
      nodeMinimum: minimumNodeVersion.join("."),
      codex: "0.148.0",
      opencode: "1.18.17",
      acpx: "0.13.1",
      claudeAcp: "0.70.0",
      codexAcp: "1.6.2",
    },
    target: { platform: process.platform, architecture: process.arch },
    runnerSourceRevision: `${revision}${dirty ? "-dirty" : ""}`,
    distDigest,
    bridgeDigest: `sha256:${createHash("sha256")
      .update(opencodeProxySha)
      .update("\n")
      .update(acpxSidecarSha)
      .update("\n")
      .update(distDigest)
      .digest("hex")}`,
    acpxProfileDigests: {
      claude:
        "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
      codex:
        "sha256:7a923b3829884d3cabcc9659d22cace3f86813e7bfffc90974b10140a45bc400",
    },
    artifacts: {
      nodeCommand: {
        path: nodeCommand,
        sha256: sha256File(join(temporaryRoot, nodeCommand)),
      },
      productionLock: {
        path: productionLock,
        sha256: sha256File(join(temporaryRoot, productionLock)),
      },
      opencodeCommand: {
        path: opencodeCommand,
        sha256: sha256File(join(temporaryRoot, opencodeCommand)),
      },
      opencodeExecutable: {
        path: opencodeExecutable,
        sha256: sha256File(join(temporaryRoot, opencodeExecutable)),
      },
      opencodeProxy: {
        path: opencodeProxyPath,
        sha256: opencodeProxySha,
      },
      acpxSidecar: { path: acpxSidecarPath, sha256: acpxSidecarSha },
    },
  };
  const manifest = {
    schema: "paperclip-runner/remote-provider-pack/v1",
    digest: `sha256:${createHash("sha256")
      .update(canonicalJson(payload))
      .digest("hex")}`,
    payload,
  };
  writeFileSync(
    join(temporaryRoot, "provider-pack.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );

  rmSync(outputRoot, { recursive: true, force: true });
  renameSync(temporaryRoot, outputRoot);
  process.stdout.write(`${outputRoot}\n`);
} finally {
  rmSync(temporaryParent, { recursive: true, force: true });
}
