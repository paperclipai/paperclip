import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSensitiveText } from "../../redaction.js";
import { canonicalProviderPackJson, type ProviderPackIdentity } from "./remote-provider-pack-verification.js";

export type ProviderPackBinding = {
  companyId: string;
  agentId: string;
  workspaceId: string;
  sessionId: string;
  runnerInstanceId: string;
  environmentLeaseId: string;
  remoteCwd: string;
  providerDigest: string;
};
export type RunnerArtifactIdentity = { version: string; digest: string };

const schema = "paperclip.remote-provider-pack-authority.v1";
const filename = "provider-pack-authority.json";
const maximumBytes = 512 * 1024;

function assertManifest(manifest: ProviderPackIdentity): void {
  if (manifest?.schema !== "paperclip-runner/remote-provider-pack/v1" || !manifest.payload
    || manifest.digest !== `sha256:${createHash("sha256").update(canonicalProviderPackJson(manifest.payload)).digest("hex")}`) {
    throw new Error("runner_remote_provider_artifact_incompatible: saved provider pack authority is invalid");
  }
}

export function resolveRemoteProviderPackAuthority<T extends ProviderPackIdentity>(input: {
  stateDirectory: string;
  binding: ProviderPackBinding;
  reattach: boolean;
  current: () => T;
  runnerArtifact: () => RunnerArtifactIdentity;
}): { manifest: T; runnerArtifact: RunnerArtifactIdentity; select: (manifest: T) => void; verified: () => void } {
  const root = lstatSync(input.stateDirectory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("runner_remote_provider_artifact_incompatible: provider pack authority directory is unsafe");
  }
  const path = join(input.stateDirectory, filename);
  let manifest: T | undefined;
  let runnerArtifact: RunnerArtifactIdentity | undefined;
  if (input.reattach) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maximumBytes) throw new Error("invalid authority file");
      const saved = JSON.parse(readFileSync(fd, "utf8"));
      if (saved.schema !== schema || canonicalProviderPackJson(saved.binding) !== canonicalProviderPackJson(input.binding)) {
        throw new Error("authority binding mismatch");
      }
      assertManifest(saved.manifest);
      if (typeof saved.runnerArtifact?.version !== "string" || !saved.runnerArtifact.version
        || !/^sha256:[a-f0-9]{64}$/.test(saved.runnerArtifact.digest)) throw new Error("invalid runner artifact identity");
      manifest = saved.manifest as T;
      runnerArtifact = saved.runnerArtifact;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("runner_remote_provider_artifact_incompatible: saved provider pack authority is invalid or does not match this execution", { cause: error });
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  manifest ??= input.current();
  assertManifest(manifest);
  runnerArtifact ??= input.runnerArtifact();
  const selectedRunner = structuredClone(runnerArtifact);
  let selected = structuredClone(manifest);
  const serialize = (manifest: T) => {
    const receipt = JSON.stringify({ schema, binding: input.binding, manifest, runnerArtifact: selectedRunner });
    if (Buffer.byteLength(receipt) > maximumBytes) throw new Error("runner_remote_provider_artifact_incompatible: provider pack authority exceeds its size limit");
    return receipt;
  };
  let receipt = serialize(selected);
  return {
    get manifest() { return selected; },
    select: (manifest: T) => {
      if (input.reattach) throw new Error("runner_remote_provider_artifact_incompatible: cannot replace an attached pack authority");
      assertManifest(manifest);
      const next = structuredClone(manifest);
      receipt = serialize(next);
      selected = next;
    },
    runnerArtifact: selectedRunner,
    verified: () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, receipt, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}

export function providerPackWorkspaceId(workspaceId: string, runId: string, environmentLeaseId: string): string {
  return workspaceId === runId ? environmentLeaseId : workspaceId;
}

export async function recordAdmittedRemoteProviderPack(
  authority: { verified: () => void },
  onWarning: (message: string) => void | Promise<void>,
): Promise<boolean> {
  try {
    authority.verified();
    return true;
  } catch (error) {
    const reason = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(-1_024);
    try {
      await onWarning(`[paperclip-runner] could not save remote release authority; recovery still requires a verified receipt or current release artifacts: ${reason}\n`);
    } catch {}
    return false;
  }
}
