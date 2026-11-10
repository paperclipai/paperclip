/** Qualification-only artifact selection. Production recovery remains in the server. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { verifyInstalledCli, type installedCliKeys } from "./installed-cli.js";
import type { MatrixExecution } from "./types.js";

export const upgradeArtifactKey = "PAPERCLIP_RUNNER_E2E_UPGRADE_ARTIFACTS";
export interface UpgradeArtifact {
  root: string;
  revision: string;
  treeSha256: string;
  evidence: "development-build" | "released";
  pins: Record<(typeof installedCliKeys)[number], string>;
}
export interface UpgradeArtifacts {
  schema: "paperclip.e2e.upgrade-artifacts/v1";
  artifacts: { A: UpgradeArtifact; B: UpgradeArtifact };
  sequence: Array<"A" | "B">;
}
export interface ServingArtifact {
  revision: string;
  treeSha256: string;
  version: string;
  evidence: UpgradeArtifact["evidence"];
}
const hex = (value: unknown, length: number): value is string => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const inside = (root: string, file: string) => {
  const part = relative(root, file);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** Hash the complete installed tree, including transitive packages and migrations.
 * Links are hashed as links and must resolve within the frozen installation.
 * Stream large binaries; never buffer a whole installation in memory.
 */
export async function installedTreeSha256(root: string): Promise<string> {
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root) throw new Error("Upgrade artifact root must be canonical");
  const hash = createHash("sha256");
  async function visit(file: string): Promise<void> {
    const before = await lstat(file, { bigint: true });
    const name = relative(root, file).split(sep).join("/");
    if (before.isSymbolicLink()) {
      if (!inside(root, await realpath(file))) throw new Error("Upgrade artifact link escapes the installation");
      hash.update(JSON.stringify([name, "link", await readlink(file)]) + "\n");
    } else if (before.isDirectory()) {
      hash.update(JSON.stringify([name, "directory"]) + "\n");
      for (const child of (await readdir(file)).sort()) {
        if (child === ".git") throw new Error("Upgrade artifacts must be installed builds outside a source checkout");
        await visit(join(file, child));
      }
    } else if (before.isFile()) {
      hash.update(JSON.stringify([name, "file", String(before.size), Number(before.mode & 0o777n)]) + "\n");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
    } else throw new Error("Upgrade artifacts must contain only regular files, directories and contained links");
    const after = await lstat(file, { bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Upgrade artifact changed during verification");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

export async function readUpgradeArtifacts(filename: string | undefined): Promise<UpgradeArtifacts | null> {
  if (!filename) return null;
  const bytes = await readFile(filename);
  if (bytes.length > 64 * 1024) throw new Error("Upgrade artifact manifest is too large");
  const value = JSON.parse(bytes.toString()) as UpgradeArtifacts;
  if (value?.schema !== "paperclip.e2e.upgrade-artifacts/v1" || !Array.isArray(value.sequence)
    || value.sequence.length < 3 || value.sequence.length > 9 || value.sequence[0] !== "A"
    || value.sequence[1] !== "B" || value.sequence[2] !== "A"
    || value.sequence.some((id, index) => (id !== "A" && id !== "B") || id === value.sequence[index - 1])) throw new Error("Upgrade qualification requires an explicit alternating A, B, A sequence");
  for (const id of ["A", "B"] as const) {
    const a = value.artifacts?.[id];
    if (!a || typeof a.root !== "string" || !hex(a.revision, 40) || !hex(a.treeSha256, 64)
      || !["released", "development-build"].includes(a.evidence) || !a.pins || typeof a.pins !== "object") throw new Error("Invalid pinned upgrade artifact");
  }
  if (value.artifacts.A.root === value.artifacts.B.root || value.artifacts.A.revision === value.artifacts.B.revision
    || value.artifacts.A.treeSha256 === value.artifacts.B.treeSha256) throw new Error("A and B must be genuinely different immutable artifacts");
  return value;
}

export async function verifyUpgradeArtifact(artifact: UpgradeArtifact, env: NodeJS.ProcessEnv, executions: readonly MatrixExecution[]) {
  const installed = await verifyInstalledCli({ ...env, ...artifact.pins }, executions);
  if (!installed || !inside(artifact.root, installed.cliRoot) || !inside(artifact.root, installed.serverRoot)) throw new Error("Upgrade packages must belong to their pinned installation");
  if (await installedTreeSha256(artifact.root) !== artifact.treeSha256) throw new Error("Upgrade installation differs from its frozen tree");
  const build = JSON.parse(await readFile(join(installed.serverRoot, "dist/build-info.json"), "utf8"));
  if (build.commit !== artifact.revision) throw new Error("Upgrade build stamp differs from its reviewed revision");
  return { installed, receipt: { revision: artifact.revision, treeSha256: artifact.treeSha256,
    version: installed.version, evidence: artifact.evidence } satisfies ServingArtifact };
}

export function assertServingArtifact(health: unknown, artifact: ServingArtifact): void {
  if (!health || typeof health !== "object" || (health as { commit?: unknown }).commit !== artifact.revision) {
    throw new Error("The serving server revision does not match the verified upgrade artifact");
  }
}
