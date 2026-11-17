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
    contractDigest?: string;
    acpxProfileDigests?: Record<string, string>;
    providers?: Record<string, unknown>;
    candidateProviders?: Record<string, unknown>;
    pins: { opencode: string; [key: string]: string | null };
    target: { platform: string; architecture: string };
    runnerSourceRevision: string;
    /** Identity of the Runner image the pack was built in, when it was built there. Provenance only. */
    runnerInputsDigest?: string;
    artifacts: { nodeCommand: { path: string; sha256: string }; opencodeCommand: { path: string; sha256: string }; [key: string]: { path: string; sha256: string } };
  };
};

export function providerPackIncompatible(check: string, detail: string): Error & { failureCheck: string } {
  return Object.assign(new Error(`runner_remote_provider_artifact_incompatible: ${detail}`), { failureCheck: check });
}

async function withProviderPackCheck<T>(step: "pack" | "opencode", verify: () => Promise<T>): Promise<T> {
  try {
    return await verify();
  } catch (error) {
    if (!(error instanceof Error) || error.name === "AbortError") throw error;
    const reported = /paperclip-pack-check=([A-Za-z0-9_.:,@/-]{1,100})/.exec(error.message)?.[1];
    const check = reported ?? (error.message.startsWith("runner_remote_provider_verification_unavailable")
      ? `${step}_verifier_unavailable` : `${step}_verifier_failed`);
    throw Object.assign(error, { failureCheck: check });
  }
}

export type ProviderPackInstallation = { root: string; manifest: unknown; immutable: boolean };
export type PackProvider = { kind: "opencode" } | { kind: "acpx"; agent: string };

/** Admission of a build-qualified, OS-protected installation. Source revisions,
 * dependency pins and unrelated provider changes are provenance, not an interface.
 * The interface is the hand-maintained compatibility revision plus the pack's
 * computed contract digest; a pack without a digest predates that check and
 * is replaced rather than reused.
 * The metadata comes from the trusted runner, never from a provider tool result.
 */
function compatibleInstallation<T extends ProviderPackIdentity>(
  installation: ProviderPackInstallation, expected: T, packRoot: string,
  provider: PackProvider, requireExactIdentity: boolean, requireCurrentOpenCodeProxy: boolean,
): T {
  const actual = installation.manifest as T | null;
  const payload = actual?.payload;
  const contract = expected.payload.compatibility?.[provider.kind];
  const failed = !installation.immutable ? "installation_unprotected"
    : installation.root !== packRoot ? "installation_root"
    : !payload ? "manifest_missing"
    : actual.schema !== expected.schema ? "schema"
    : actual.digest !== `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}` ? "manifest_digest"
    : canonicalProviderPackJson(payload.target) !== canonicalProviderPackJson(expected.payload.target) ? "target"
    : requireExactIdentity ? (actual.digest !== expected.digest ? "exact_identity" : null)
    : !Number.isSafeInteger(contract) || contract! < 1 ? "expected_compatibility_missing"
    : payload.compatibility?.[provider.kind] !== contract ? "compatibility_revision"
    : !/^sha256:[a-f0-9]{64}$/.test(expected.payload.contractDigest ?? "") ? "expected_contract_digest_missing"
    : payload.contractDigest === undefined ? "contract_digest_missing"
    : payload.contractDigest !== expected.payload.contractDigest ? "contract_digest"
    : null;
  if (failed || !actual || !payload || typeof payload.pins?.opencode !== "string") {
    throw providerPackIncompatible(failed ?? "opencode_pin_missing", "installed provider pack interface or installation is incompatible");
  }
  // Launch profiles and recovery receipts bind the selected installation's own
  // bytes, never the current controller's artifact hashes.
  for (const [name, expectedArtifact] of Object.entries(expected.payload.artifacts)) {
    const artifact = payload.artifacts?.[name];
    if (artifact?.path !== expectedArtifact.path || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw providerPackIncompatible(`artifact:${name}`, "installed provider pack artifact identity is invalid");
    }
  }
  if (provider.kind === "opencode" && requireCurrentOpenCodeProxy
    && payload.artifacts.opencodeProxy?.sha256 !== expected.payload.artifacts.opencodeProxy?.sha256) {
    throw providerPackIncompatible("opencode_proxy", "installed proxy does not match the requested OpenCode diagnostics");
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
      throw providerPackIncompatible("acpx_profile", "selected ACPX provider profile is incompatible");
    }
  }
  return structuredClone(actual);
}

export async function verifyRemoteProviderPack<T extends ProviderPackIdentity>({ runner, cwd, packRoot, manifest, installation, provider, requireExactIdentity = false, requireCurrentOpenCodeProxy = false, acceptProvenance = false }: {
  runner: CommandManagedRuntimeRunner;
  cwd: string;
  packRoot: string;
  manifest: T;
  installation?: ProviderPackInstallation;
  provider?: PackProvider;
  requireExactIdentity?: boolean;
  requireCurrentOpenCodeProxy?: boolean;
  acceptProvenance?: boolean;
}): Promise<T> {
  if (installation) {
    if (!provider) throw new Error("runner_remote_provider_artifact_incompatible: provider interface is required");
    return compatibleInstallation(installation, manifest, packRoot, provider, requireExactIdentity, requireCurrentOpenCodeProxy);
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
    "const fail=(check,detail)=>{fs.writeSync(2,detail+'\\n');fs.writeSync(1,'\\npaperclip-pack-check='+check+'\\n');process.exit(3)}",
    "let actual;try{actual=fs.readFileSync(path.join(root,'provider-pack.json'),'utf8').trim()}catch{fail('manifest_unreadable','provider pack manifest unreadable')}",
    "const canonical=(v)=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v)",
    "let manifest;try{manifest=JSON.parse(actual)}catch{fail('manifest_invalid','provider pack manifest invalid')}",
    "const differing=(a,b)=>[...new Set([...Object.keys(a||{}),...Object.keys(b||{})])].sort().filter(k=>canonical((a||{})[k])!==canonical((b||{})[k]))",
    "const provenance=process.argv[3]==='provenance'",
    "const content=(m)=>{const c=JSON.parse(JSON.stringify(m??null))??{};delete c.digest;if(c.payload&&typeof c.payload==='object'){delete c.payload.runnerSourceRevision;delete c.payload.runnerInputsDigest}return canonical(c)}",
    "const sealed=manifest?.digest==='sha256:'+crypto.createHash('sha256').update(canonical(manifest?.payload)).digest('hex')",
    "if(canonical(manifest)!==expected&&!(provenance&&sealed&&content(manifest)===content(JSON.parse(expected)))){const wanted=JSON.parse(expected);const keys=differing(manifest,wanted).flatMap(k=>k==='payload'?differing(manifest.payload,wanted.payload):k==='digest'?[]:[k]);fail('manifest_mismatch:'+keys.join(',').slice(0,90),'manifest mismatch')}",
    "const hash=(p)=>{try{return 'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')}catch{return 'unreadable'}}",
    "const walk=(treeRoot)=>{const digest=crypto.createHash('sha256');const visit=(directory,prefix='')=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const relative=prefix?prefix+'/'+entry.name:entry.name;const absolute=path.join(directory,entry.name);if(entry.isDirectory()){digest.update('directory\\0'+relative+'\\n');visit(absolute,relative)}else if(entry.isFile()){digest.update('file\\0'+relative+'\\0'+'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')+'\\n')}else if(entry.isSymbolicLink()){digest.update('symlink\\0'+relative+'\\0'+fs.readlinkSync(absolute)+'\\n')}else throw new Error('unsupported dist entry '+relative)}};visit(treeRoot);return 'sha256:'+digest.digest('hex')}",
    "const tree=(treeRoot)=>{try{return walk(treeRoot)}catch{return 'unreadable'}}",
    "for(const name of ['nodeCommand','productionLock','opencodeCommand','opencodeExecutable','opencodeProxy','acpxSidecar','grokLauncher']){const artifact=manifest.payload.artifacts[name];if(hash(artifact.path)!==artifact.sha256)fail('artifact_digest:'+name,name+' digest mismatch')}",
    "if(tree(path.join(root,'dist'))!==manifest.payload.distDigest)fail('dist_digest','dist tree digest mismatch')",
    "for(const candidate of Object.values({...manifest.payload.providers,...manifest.payload.candidateProviders})){if(tree(path.join(root,candidate.path))!==candidate.sha256)fail('candidate_digest','candidate asset tree digest mismatch')}",
    "const version=process.versions.node.split('.').map(Number)",
    "const minimum=manifest.payload.pins.nodeMinimum.split('.').map(Number)",
    "if(version[0]<minimum[0]||(version[0]===minimum[0]&&(version[1]<minimum[1]||(version[1]===minimum[1]&&version[2]<minimum[2]))))fail('node_version','Node version incompatible')",
    "if(process.platform!==manifest.payload.target.platform||process.arch!==manifest.payload.target.architecture)fail('target','provider pack target mismatch')",
    "const packageVersion=(pkg)=>{try{return JSON.parse(fs.readFileSync(path.join(root,'node_modules',...pkg.split('/'),'package.json'),'utf8')).version}catch{return null}}",
    "const expectedPackages={acpx:manifest.payload.pins.acpx,'@agentclientprotocol/claude-agent-acp':manifest.payload.pins.claudeAcp,'@agentclientprotocol/codex-acp':manifest.payload.pins.codexAcp,'opencode-ai':manifest.payload.pins.opencode}",
    "for(const [pkg,version] of Object.entries(expectedPackages))if(packageVersion(pkg)!==version)fail('package_version:'+pkg,pkg+' version mismatch')",
    "if(provenance)process.stdout.write('\\npaperclip-pack-manifest='+Buffer.from(canonical(manifest)).toString('base64')+'\\n')",
  ].join(";");
  const verified = await withProviderPackCheck("pack", () => runRemoteProviderVerification(() => runner.execute({
    command: providerNodeCommand,
    args: ["-e", verifyScript, packRoot, expected, ...(acceptProvenance ? ["provenance"] : [])],
    cwd: cwd,
    bypassSession: true,
    timeoutMs: 30_000,
  }), "provider pack verification"));
  const selected = acceptProvenance ? sameContentManifest(manifest, verified.stdout) : manifest;
  const opencodeCommand = posix.join(
    packRoot,
    manifest.payload.artifacts.opencodeCommand.path,
  );
  const opencodeVersion = await withProviderPackCheck("opencode", () => runRemoteProviderVerification(() => runner.execute({
    command: opencodeCommand,
    args: ["--version"],
    cwd: cwd,
    bypassSession: true,
    timeoutMs: 30_000,
  }), "OpenCode version verification"));
  if (
    opencodeVersion.stdout.trim() !== manifest.payload.pins.opencode
  ) {
    throw providerPackIncompatible("opencode_version", "OpenCode version mismatch");
  }
  return structuredClone(selected);
}

const PROVENANCE_FIELDS = ["runnerSourceRevision", "runnerInputsDigest"] as const;

export function providerPackContent(manifest: ProviderPackIdentity): string {
  const payload: Record<string, unknown> = { ...manifest.payload };
  for (const field of PROVENANCE_FIELDS) delete payload[field];
  return canonicalProviderPackJson({ schema: manifest.schema, payload });
}

function sameContentManifest<T extends ProviderPackIdentity>(expected: T, stdout: string): T {
  const encoded = /paperclip-pack-manifest=([A-Za-z0-9+/=]{1,200000})/.exec(stdout)?.[1];
  let installed: T | null = null;
  try { installed = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T : null; } catch {}
  if (!installed?.payload || installed.schema !== expected.schema
    || installed.digest !== `sha256:${createHash("sha256").update(canonicalProviderPackJson(installed.payload)).digest("hex")}`
    || providerPackContent(installed) !== providerPackContent(expected)
    || !/^[0-9a-f]{40}(?:-dirty)?$/.test(installed.payload.runnerSourceRevision)
    || (installed.payload.runnerInputsDigest !== undefined && !/^[0-9a-f]{64}$/.test(installed.payload.runnerInputsDigest))) {
    throw providerPackIncompatible("installed_manifest_invalid", "installed provider pack identity is invalid");
  }
  return installed;
}
