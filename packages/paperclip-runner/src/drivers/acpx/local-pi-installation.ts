import { createHash } from "node:crypto";
import { lstat, realpath, symlink, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { verifyNativeAcpxInstallation } from "./installation-integrity.js";

export const LOCAL_PI_CONFIGURATION_ENV = "PAPERCLIP_RUNNER_LOCAL_PI";

interface LocalPiConfiguration {
  assets: string;
  sha256: string;
  profile: string;
  identity: string;
}

export async function resolveLocalPiConfiguration(raw: string | undefined): Promise<LocalPiConfiguration | undefined> {
  if (raw === undefined) return undefined;
  const invalid = () => new Error("Invalid operator configuration for the local Pi Runner");
  if (raw.length > 8192) throw invalid();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const { assets, sha256, profile, companyId, agentId } = value as Record<string, unknown>;
  const guid = (id: unknown) => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
  if (!guid(companyId) || !guid(agentId)) throw invalid();
  if (Object.keys(value).length !== 5 || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw invalid();
  async function directory(path: unknown): Promise<string> {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f\u007f]/.test(path)) throw invalid();
    if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw invalid();
    return path;
  }
  const roots = { assets: await directory(assets), profile: await directory(profile) };
  const sameTree = (root: string, child: string) => {
    const suffix = relative(root, child);
    return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
  };
  if (sameTree(roots.assets, roots.profile) || sameTree(roots.profile, roots.assets)) throw invalid();
  await privateAuthFile(roots.profile);
  return { ...roots, sha256, identity: `sha256:${createHash("sha256").update(JSON.stringify({ ...roots, sha256, companyId, agentId })).digest("hex")}` };
}

export function verifyLocalPiInstallation(config: LocalPiConfiguration) {
  return verifyNativeAcpxInstallation({
    distributionRoot: join(config.assets, "runtime"),
    manifestPath: join(config.assets, "native-closure.json"),
    expectedClosureSha256: config.sha256,
    executable: "node/bin/node",
    entrypoint: "pi-entry.cjs",
    fixedArguments: [],
  });
}

async function privateAuthFile(profile: string): Promise<string> {
  const source = join(profile, "auth.json");
  const metadata = await lstat(source);
  if (await realpath(source) !== source || !metadata.isFile() || metadata.nlink !== 1
    || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Local Pi profile requires a private, user-owned auth.json");
  }
  return source;
}

/** Pi owns the account lock and refresh. Runner owns the rest of the session directory. */
export async function bindLocalPiProfile(profile: string, destination: string): Promise<void> {
  const source = await privateAuthFile(profile);
  const binding = join(destination, "auth.json");
  try { await symlink(source, binding); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await lstat(binding)).isSymbolicLink() || await readlink(binding) !== source) {
      throw new Error("Local Pi authentication binding changed");
    }
  }
}
