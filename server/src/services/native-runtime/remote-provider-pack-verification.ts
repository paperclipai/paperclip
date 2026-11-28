import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runRemoteProviderVerification } from "./remote-provider-pack.js";

import { canonicalProviderPackJson, providerPackIncompatible, compatibleProviderPackInstallation, requiredProviderAssetNames,
  type ProviderPackIdentity, type ProviderPackInstallation, type PackProvider, type AdmittedProviderPackReceipt } from "./provider-pack-compatibility.js";
export { canonicalProviderPackJson, providerPackIncompatible, type ProviderPackIdentity,
  type ProviderPackInstallation, type PackProvider, type AdmittedProviderPackReceipt } from "./provider-pack-compatibility.js";

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

/**
 * A Node expression defining `packIdentity(root)`: a digest of the kernel
 * identity of every entry under the pack's real root (path, mode, device,
 * inode, size, mtime, ctime, link count, owner; a symlink's text and its
 * target's identity), bound to the machine's boot. Content cannot change
 * without moving a ctime, and no unprivileged process can set a ctime back,
 * so an unchanged identity proves bytes unchanged since they were hashed.
 */
export const PROVIDER_PACK_IDENTITY_FUNCTION = [
  "const packIdentity=(root)=>{const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const h=crypto.createHash('sha256');let boot='none';try{boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}catch{}",
  "const real=fs.realpathSync(root);h.update('boot\\0'+boot+'\\nroot\\0'+real+'\\n');const id=(s)=>[s.mode,s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink,s.uid].join('\\0');h.update('.\\0'+id(fs.lstatSync(real,{bigint:true}))+'\\n');",
  "const visit=(d,prefix)=>{for(const name of fs.readdirSync(d).sort()){const a=path.join(d,name),r=prefix?prefix+'/'+name:name,s=fs.lstatSync(a,{bigint:true});h.update(r+'\\0'+id(s)+'\\n');if(s.isSymbolicLink()){let t='missing';try{t=id(fs.statSync(a,{bigint:true}))}catch{}h.update('link\\0'+fs.readlinkSync(a)+'\\0'+t+'\\n')}else if(s.isDirectory())visit(a,r)}};visit(real,'');return h.digest('hex')}",
].join("");

type SealedPackRecord = { identity: string; manifest: ProviderPackIdentity };
/** Fully verified packs this server process has sealed, by target and expected identity. */
const sealedPacks = new Map<string, SealedPackRecord>();
const MAX_SEALED_PACKS = 512;

/** Test seam: forget every sealed pack record. */
export function clearSealedProviderPacksForTest(): void { sealedPacks.clear(); }

function sealKeyFor(
  seal: { targetKey: string } | undefined,
  packRoot: string,
  manifest: ProviderPackIdentity,
  acceptProvenance: boolean,
  requiredAssets: readonly string[] | null,
): string | null {
  if (!seal?.targetKey) return null;
  return createHash("sha256").update(canonicalProviderPackJson([seal.targetKey, packRoot, manifest, acceptProvenance, requiredAssets])).digest("hex");
}

const reportedIdentity = (stdout: string) => /paperclip-pack-identity=([a-f0-9]{64})/.exec(stdout)?.[1] ?? null;

export async function verifyRemoteProviderPack<T extends ProviderPackIdentity>({ runner, cwd, packRoot, manifest, installation, provider, requireExactIdentity = false, requireCurrentOpenCodeProxy = false, acceptProvenance = false, admittedReceipt, seal }: {
  runner: CommandManagedRuntimeRunner;
  cwd: string;
  packRoot: string;
  manifest: T;
  installation?: ProviderPackInstallation;
  provider?: PackProvider;
  requireExactIdentity?: boolean;
  requireCurrentOpenCodeProxy?: boolean;
  acceptProvenance?: boolean;
  admittedReceipt?: AdmittedProviderPackReceipt;
  /**
   * The exact sandbox this pack sits on. After one full verification the
   * server keeps the pack's kernel identity; later runs on the same sandbox
   * re-check only that identity instead of re-hashing every byte.
   */
  seal?: { targetKey: string };
}): Promise<T> {
  if (installation) {
    if (!provider) throw new Error("runner_remote_provider_artifact_incompatible: provider interface is required");
    return compatibleProviderPackInstallation(installation, manifest, packRoot, provider, requireExactIdentity, requireCurrentOpenCodeProxy, admittedReceipt);
  }
  const providerNodeCommand = posix.join(
    packRoot,
    manifest.payload.artifacts.nodeCommand.path,
  );
  const requiredAssets = requiredProviderAssetNames(provider, manifest);
  const sealKey = sealKeyFor(seal, packRoot, manifest, acceptProvenance, requiredAssets);
  const sealed = sealKey ? sealedPacks.get(sealKey) : undefined;
  if (sealKey && sealed) {
    // Any failure or difference falls through to the full verification.
    const current = await runner.execute({
      command: providerNodeCommand,
      args: ["-e", `${PROVIDER_PACK_IDENTITY_FUNCTION};process.stdout.write('\\npaperclip-pack-identity='+packIdentity(process.argv[1])+'\\n')`, packRoot],
      cwd, bypassSession: true, timeoutMs: 30_000,
    }).catch(() => null);
    if (current && current.exitCode === 0 && !current.timedOut && reportedIdentity(current.stdout) === sealed.identity) {
      return structuredClone(sealed.manifest) as T;
    }
    sealedPacks.delete(sealKey);
  }
  const expected = Buffer.from(
    canonicalProviderPackJson(manifest),
    "utf8",
  ).toString("base64");
  const verifyScript = [
    ...(sealKey ? [PROVIDER_PACK_IDENTITY_FUNCTION, "let identityBefore=null;try{identityBefore=packIdentity(process.argv[1])}catch{}"] : []),
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
    "const requiredCandidates=process.argv[4]?JSON.parse(process.argv[4]):null",
    "for(const [name,candidate] of Object.entries({...manifest.payload.providers,...manifest.payload.candidateProviders})){if(requiredCandidates!==null&&!requiredCandidates.includes(name))continue;if(tree(path.join(root,candidate.path))!==candidate.sha256)fail('candidate_digest','candidate asset tree digest mismatch')}",
    "const version=process.versions.node.split('.').map(Number)",
    "const minimum=manifest.payload.pins.nodeMinimum.split('.').map(Number)",
    "if(version[0]<minimum[0]||(version[0]===minimum[0]&&(version[1]<minimum[1]||(version[1]===minimum[1]&&version[2]<minimum[2]))))fail('node_version','Node version incompatible')",
    "if(process.platform!==manifest.payload.target.platform||process.arch!==manifest.payload.target.architecture)fail('target','provider pack target mismatch')",
    "const packageVersion=(pkg)=>{try{return JSON.parse(fs.readFileSync(path.join(root,'node_modules',...pkg.split('/'),'package.json'),'utf8')).version}catch{return null}}",
    "const expectedPackages={acpx:manifest.payload.pins.acpx,'@agentclientprotocol/claude-agent-acp':manifest.payload.pins.claudeAcp,'@agentclientprotocol/codex-acp':manifest.payload.pins.codexAcp,'opencode-ai':manifest.payload.pins.opencode}",
    "for(const [pkg,version] of Object.entries(expectedPackages))if(packageVersion(pkg)!==version)fail('package_version:'+pkg,pkg+' version mismatch')",
    "if(provenance)process.stdout.write('\\npaperclip-pack-manifest='+Buffer.from(canonical(manifest)).toString('base64')+'\\n')",
    // Seal only when no entry changed while it was being hashed.
    ...(sealKey ? ["let identityAfter=null;try{identityAfter=packIdentity(root)}catch{}if(identityBefore&&identityBefore===identityAfter)process.stdout.write('\\npaperclip-pack-identity='+identityAfter+'\\n')"] : []),
  ].join(";");
  const verifyArgs = requiredAssets !== null
    ? ["-e", verifyScript, packRoot, expected, acceptProvenance ? "provenance" : "", JSON.stringify(requiredAssets)]
    : ["-e", verifyScript, packRoot, expected, ...(acceptProvenance ? ["provenance"] : [])];
  const verified = await withProviderPackCheck("pack", () => runRemoteProviderVerification(() => runner.execute({
    command: providerNodeCommand,
    args: verifyArgs,
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
  const identity = sealKey ? reportedIdentity(verified.stdout) : null;
  if (sealKey && identity) {
    if (sealedPacks.size >= MAX_SEALED_PACKS) sealedPacks.delete(sealedPacks.keys().next().value!);
    sealedPacks.set(sealKey, { identity, manifest: structuredClone(selected) });
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
