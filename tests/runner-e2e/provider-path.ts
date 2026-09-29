import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProviderPathProvenance {
  selectedOrigin: "explicit_override" | "pinned_dependency";
  resolvedPath: string;
  entrypointSha256: string;
  providerNativeVersion: "not_probed";
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function assertExecutableFile(filePath: string) {
  if (!path.isAbsolute(filePath)) {
    throw new Error("PAPERCLIP_RUNNER_E2E_CODEX_COMMAND must be an absolute path");
  }
  const resolvedPath = await realpath(filePath).catch(() => null);
  if (!resolvedPath) {
    throw new Error(`Codex executable does not exist: ${filePath}`);
  }
  const metadata = await stat(resolvedPath);
  if (!metadata.isFile()) {
    throw new Error(`Codex executable must be a file: ${filePath}`);
  }
  await access(resolvedPath, process.platform === "win32" ? undefined : 0o1).catch(
    () => {
      throw new Error(`Codex executable is not executable: ${filePath}`);
    },
  );
  return resolvedPath;
}

export async function prepareProviderPath(input: {
  temporaryRoot: string;
  inheritedPath: string | undefined;
  explicitOverride?: string;
  resolvePinnedExecutable: () => Promise<string>;
}): Promise<{ path: string; provenance: ProviderPathProvenance }> {
  const toolBin = path.join(input.temporaryRoot, "provider-bin");
  await mkdir(toolBin, { recursive: true });
  const selectedOrigin = input.explicitOverride
    ? "explicit_override"
    : "pinned_dependency";
  const candidate = input.explicitOverride ?? (await input.resolvePinnedExecutable());
  const resolvedPath = await assertExecutableFile(candidate);
  const provenance: ProviderPathProvenance = {
    selectedOrigin,
    resolvedPath,
    entrypointSha256: await sha256File(resolvedPath),
    // Hashing the selected wrapper/script does not establish the version of
    // the native provider it may launch. Record that no native probe ran.
    providerNativeVersion: "not_probed",
  };
  await symlink(resolvedPath, path.join(toolBin, "codex"));
  return {
    path: [toolBin, input.inheritedPath].filter(Boolean).join(path.delimiter),
    provenance,
  };
}

export async function writeProviderPathProvenance(
  filePath: string,
  provenance: ProviderPathProvenance,
) {
  await writeFile(filePath, `${JSON.stringify(provenance, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
