import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runRemoteProviderVerification } from "./remote-provider-pack.js";

export function canonicalProviderPackJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalProviderPackJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalProviderPackJson(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export type ProviderPackIdentity = {
  schema: string;
  digest: string;
  payload: {
    compatibility?: { opencode: number; acpx: number };
    acpxProfileDigests?: Record<string, string>;
    providers?: Record<string, unknown>;
    candidateProviders?: Record<string, unknown>;
    pins: { opencode: string; [key: string]: string | null };
    target: { platform: string; architecture: string };
    runnerSourceRevision: string;
    artifacts: { nodeCommand: { path: string; sha256: string }; opencodeCommand: { path: string; sha256: string }; [key: string]: { path: string; sha256: string } };
  };
};

export type ProviderPackInstallation = { root: string; manifest: unknown; immutable: boolean };
export type PackProvider = { kind: "opencode" } | { kind: "acpx"; agent: string };

/** Admission of a build-qualified, OS-protected installation. Source revisions,
 * dependency pins and unrelated provider changes are provenance, not an interface.
 * The metadata comes from the trusted runner, never from a provider tool result.
 */
function compatibleInstallation<T extends ProviderPackIdentity>(
  installation: ProviderPackInstallation, expected: T, packRoot: string,
  provider: PackProvider, requireExactIdentity: boolean,
): T {
  const actual = installation.manifest as T | null;
  const payload = actual?.payload;
  const contract = expected.payload.compatibility?.[provider.kind];
  if (!installation.immutable || installation.root !== packRoot || !payload
    || actual.schema !== expected.schema
    || actual.digest !== `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}`
    || canonicalProviderPackJson(payload.target) !== canonicalProviderPackJson(expected.payload.target)
    || (requireExactIdentity ? actual.digest !== expected.digest
      : !Number.isSafeInteger(contract) || contract! < 1 || payload.compatibility?.[provider.kind] !== contract)
    || typeof payload.pins?.opencode !== "string") {
    throw new Error("runner_remote_provider_artifact_incompatible: installed provider pack interface or installation is incompatible");
  }
  // Launch profiles and recovery receipts bind the selected installation's own
  // bytes, never the current controller's artifact hashes.
  for (const [name, expectedArtifact] of Object.entries(expected.payload.artifacts)) {
    const artifact = payload.artifacts?.[name];
    if (artifact?.path !== expectedArtifact.path || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error("runner_remote_provider_artifact_incompatible: installed provider pack artifact identity is invalid");
    }
  }
  if (provider.kind === "acpx") {
    const agent = provider.agent;
    const currentProfile = expected.payload.acpxProfileDigests?.[agent];
    const selected = expected.payload.providers?.[agent] ?? expected.payload.candidateProviders?.[agent];
    const installed = payload.providers?.[agent] ?? payload.candidateProviders?.[agent];
    // ACPX's existing qualified launch profiles remain authoritative for the
    // selected agent. Other providers in the same pack do not invalidate it.
    if (currentProfile ? payload.acpxProfileDigests?.[agent] !== currentProfile
      : !selected || !installed || ["version", "profileDigest", "closureDigest", "qualification", "path"].some(key =>
          (installed as Record<string, unknown>)[key] !== (selected as Record<string, unknown>)[key])) {
      throw new Error("runner_remote_provider_artifact_incompatible: selected ACPX provider profile is incompatible");
    }
  }
  return structuredClone(actual);
}

export async function verifyRemoteProviderPack<T extends ProviderPackIdentity>({ runner, cwd, packRoot, manifest, installation, provider, requireExactIdentity = false }: {
  runner: CommandManagedRuntimeRunner;
  cwd: string;
  packRoot: string;
  manifest: T;
  installation?: ProviderPackInstallation;
  provider?: PackProvider;
  requireExactIdentity?: boolean;
}): Promise<T> {
  if (installation) {
    if (!provider) throw new Error("runner_remote_provider_artifact_incompatible: provider interface is required");
    return compatibleInstallation(installation, manifest, packRoot, provider, requireExactIdentity);
  }
  const expected = Buffer.from(
    canonicalProviderPackJson(manifest),
    "utf8",
  ).toString("base64");
  const providerNodeCommand = posix.join(
    packRoot,
    manifest.payload.artifacts.nodeCommand.path,
  );
  const verifyScript = [
    "const fs=require('node:fs')",
    "const crypto=require('node:crypto')",
    "const path=require('node:path')",
    "const root=process.argv[1]",
    "const expected=Buffer.from(process.argv[2],'base64').toString('utf8')",
    "const actual=fs.readFileSync(path.join(root,'provider-pack.json'),'utf8').trim()",
    "const canonical=(v)=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v)",
    "const manifest=JSON.parse(actual)",
    "if(canonical(manifest)!==expected)throw new Error('manifest mismatch')",
    "const hash=(p)=>'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')",
    "const tree=(treeRoot)=>{const digest=crypto.createHash('sha256');const visit=(directory,prefix='')=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const relative=prefix?prefix+'/'+entry.name:entry.name;const absolute=path.join(directory,entry.name);if(entry.isDirectory()){digest.update('directory\\0'+relative+'\\n');visit(absolute,relative)}else if(entry.isFile()){digest.update('file\\0'+relative+'\\0'+'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')+'\\n')}else if(entry.isSymbolicLink()){digest.update('symlink\\0'+relative+'\\0'+fs.readlinkSync(absolute)+'\\n')}else throw new Error('unsupported dist entry '+relative)}};visit(treeRoot);return 'sha256:'+digest.digest('hex')}",
    "for(const name of ['nodeCommand','productionLock','opencodeCommand','opencodeExecutable','opencodeProxy','acpxSidecar','grokLauncher']){const artifact=manifest.payload.artifacts[name];if(hash(artifact.path)!==artifact.sha256)throw new Error(name+' digest mismatch')}",
    "if(tree(path.join(root,'dist'))!==manifest.payload.distDigest)throw new Error('dist tree digest mismatch')",
    "for(const candidate of Object.values({...manifest.payload.providers,...manifest.payload.candidateProviders})){if(tree(path.join(root,candidate.path))!==candidate.sha256)throw new Error('candidate asset tree digest mismatch')}",
    "const version=process.versions.node.split('.').map(Number)",
    "const minimum=manifest.payload.pins.nodeMinimum.split('.').map(Number)",
    "if(version[0]<minimum[0]||(version[0]===minimum[0]&&(version[1]<minimum[1]||(version[1]===minimum[1]&&version[2]<minimum[2]))))throw new Error('Node version incompatible')",
    "if(process.platform!==manifest.payload.target.platform||process.arch!==manifest.payload.target.architecture)throw new Error('provider pack target mismatch')",
    "const packageVersion=(pkg)=>JSON.parse(fs.readFileSync(path.join(root,'node_modules',...pkg.split('/'),'package.json'),'utf8')).version",
    "const expectedPackages={acpx:manifest.payload.pins.acpx,'@agentclientprotocol/claude-agent-acp':manifest.payload.pins.claudeAcp,'@agentclientprotocol/codex-acp':manifest.payload.pins.codexAcp,'opencode-ai':manifest.payload.pins.opencode}",
    "for(const [pkg,version] of Object.entries(expectedPackages))if(packageVersion(pkg)!==version)throw new Error(pkg+' version mismatch')",
  ].join(";");
  await runRemoteProviderVerification(() => runner.execute({
    command: providerNodeCommand,
    args: ["-e", verifyScript, packRoot, expected],
    cwd: cwd,
    bypassSession: true,
    timeoutMs: 30_000,
  }), "provider pack verification");
  const opencodeCommand = posix.join(
    packRoot,
    manifest.payload.artifacts.opencodeCommand.path,
  );
  const opencodeVersion = await runRemoteProviderVerification(() => runner.execute({
    command: opencodeCommand,
    args: ["--version"],
    cwd: cwd,
    bypassSession: true,
    timeoutMs: 30_000,
  }), "OpenCode version verification");
  if (
    opencodeVersion.stdout.trim() !== manifest.payload.pins.opencode
  ) {
    throw new Error(
      "runner_remote_provider_artifact_incompatible: OpenCode version mismatch",
    );
  }
  return structuredClone(manifest);
}
