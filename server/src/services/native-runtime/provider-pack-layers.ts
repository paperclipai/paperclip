import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeRunTrace } from "./native-run-trace.js";
import { providerPackExtractionProbe } from "./provider-pack-extraction.js";

type Archive = { sha256: string; bytes: number };
type FileLayer = Archive & { path: string; mode: number; archive: Archive };
export type ProviderPackLayers = {
  kind: "layers";
  sourceRoot: string;
  overlay: Archive;
  files: FileLayer[];
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const validArchive = (value: unknown): value is Archive => {
  const entry = value as Archive | null;
  return !!entry && /^[a-f0-9]{64}$/.test(entry.sha256)
    && Number.isSafeInteger(entry.bytes) && entry.bytes > 0;
};

// The run report keeps only the outer message. Name the failed check with a
// fixed reason so a recurrence is diagnosable without exposing private paths.
export const invalidArchive = (reason: string, cause?: unknown) =>
  new Error(`runner_remote_provider_archive_invalid: ${reason}`, cause === undefined ? undefined : { cause });

const verifiedArchives = new Set<string>();
const archiveIdentity = (path: string, expected: Archive, metadata: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
  [path, expected.sha256, metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join("\0");

export async function verifyArchive(path: string, expected: Archive, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw invalidArchive("archive_unreadable", error); }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw invalidArchive("archive_not_file");
    if (metadata.size !== expected.bytes) throw invalidArchive("size_mismatch");
    const identity = archiveIdentity(path, expected, metadata);
    if (verifiedArchives.has(identity)) return;
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk);
    signal?.throwIfAborted();
    if (hash.digest("hex") !== expected.sha256) throw invalidArchive("sha256_mismatch");
    if (verifiedArchives.size >= 1_024) verifiedArchives.clear();
    verifiedArchives.add(identity);
  } finally { await file.close(); }
}

export async function readProviderPackLayers(root: string, expectedDigest: string, value: unknown, signal?: AbortSignal): Promise<ProviderPackLayers> {
  const receipt = value as { encoding: string; providerPackDigest: string; overlay: Archive; files: FileLayer[] };
  if (receipt.providerPackDigest !== expectedDigest) throw invalidArchive("receipt_identity_mismatch");
  if (receipt.encoding !== "tar+zstd"
    || !validArchive(receipt.overlay) || !Array.isArray(receipt.files) || receipt.files.length > 10_000) {
    throw invalidArchive("receipt_invalid");
  }
  const paths = new Set<string>();
  for (const file of receipt.files) {
    if (!validArchive(file) || !validArchive(file.archive)
      || typeof file.path !== "string" || !file.path || file.path.length > 4096
      || file.path.startsWith("/") || file.path.includes("\\") || file.path.includes("\0")
      || file.path.split("/").some(part => !part || part === "." || part === "..")
      || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || paths.has(file.path)) {
      throw invalidArchive("layer_invalid");
    }
    paths.add(file.path);
  }
  for (const path of paths) {
    let parent = posix.dirname(path);
    while (parent !== ".") {
      if (paths.has(parent)) throw invalidArchive("layer_invalid");
      parent = posix.dirname(parent);
    }
  }
  const sourceRoot = `${root}.archives`;
  const layers = await lstat(sourceRoot).catch(error => { throw invalidArchive("layers_unreadable", error); });
  if (!layers.isDirectory()) throw invalidArchive("layers_unreadable");
  await verifyArchive(`${sourceRoot}/overlay.tar.zst`, receipt.overlay, signal);
  return { kind: "layers", sourceRoot, overlay: receipt.overlay, files: receipt.files };
}

/** A provider asset tree the pack manifest seals with a tree digest. */
export type ProviderPackTree = { path: string; sha256: string };

// Reuse identical image bytes without spending sandbox disk on a second copy.
//
// The image pack is installed by root and the run user cannot write it. When a
// file or tree, and every directory above it, is owned by another user and is
// not writable by group or others, the run cannot change it, so a symlink to
// it is as safe as a private copy (a run user with sudo can change either).
// - A provider asset tree is linked whole, after its bytes hash to the tree
//   digest the pack manifest seals. Linking whole trees keeps a provider's own
//   files together, and the pack verifier hashes the linked tree again.
// - Another large file is linked when its bytes match. JavaScript files are
//   always copied, so Node resolves their imports inside this pack.
// - Anything else is copied and hashed privately as before. A file whose bytes
//   were already copied for another path is hardlinked to that private copy.
const reuseScript = `
(async()=>{
 // Cold image reads are latency-bound; more I/O threads read a tree in parallel.
 process.env.UV_THREADPOOL_SIZE='32';
 const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
 const spec=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
 const f=fs.promises;await f.mkdir(p.dirname(spec.target),{recursive:true,mode:448});
 await f.mkdir(spec.target,{mode:448});
 const missing=[],linkedTrees=[],copies=new Map(),uid=spec.runUid??process.getuid();
 const roots=[];for(const root of spec.roots){try{roots.push(await f.realpath(root))}catch{}}
 const trees=spec.trees??[];
 const under=(path,tree)=>path===tree||path.startsWith(tree+'/');
 const protectedEntry=s=>s.uid!==uid&&((s.mode&18)===0||(s.isDirectory()&&(s.mode&512)!==0));
 const protectedAncestors=async(path)=>{
   for(let current=p.dirname(path);;current=p.dirname(current)){
     const s=await f.lstat(current);if(!s.isDirectory()||!protectedEntry(s))return false;
     if(p.dirname(current)===current)return true;}
 };
 const buffer=Buffer.allocUnsafe(1<<20);
 const fileHash=(path)=>{const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   try{const hash=c.createHash('sha256');for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null))>0;)hash.update(buffer.subarray(0,n));return hash.digest('hex')}
   finally{fs.closeSync(fd)}};
 const fileHashAsync=async(path,chunk)=>{const handle=await f.open(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   try{const hash=c.createHash('sha256');for(;;){const {bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;hash.update(chunk.subarray(0,bytesRead))}return hash.digest('hex')}
   finally{await handle.close()}};
 // The same tree digest as the pack verifier, over protected entries only.
 // A provider tree holds thousands of small files: walk it synchronously,
 // then read its files in parallel and hash them in walk order.
 const treeHash=async(root)=>{const records=[],files=[];
   const visit=(directory,prefix)=>{
     for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
       const relative=prefix?prefix+'/'+entry.name:entry.name,absolute=p.join(directory,entry.name),s=fs.lstatSync(absolute);
       if(s.isSymbolicLink()){records.push('symlink\\0'+relative+'\\0'+fs.readlinkSync(absolute)+'\\n');continue}
       if(!protectedEntry(s))throw Error('unprotected');
       if(s.isDirectory()){records.push('directory\\0'+relative+'\\n');visit(absolute,relative)}
       else if(s.isFile()){files.push([records.length,relative,absolute]);records.push('')}
       else throw Error('unsupported');}};
   visit(root,'');
   let next=0;
   await Promise.all(Array.from({length:32},async()=>{const chunk=Buffer.allocUnsafe(1<<20);
     while(next<files.length){const [index,relative,absolute]=files[next++];
       records[index]='file\\0'+relative+'\\0sha256:'+await fileHashAsync(absolute,chunk)+'\\n';}}));
   const digest=c.createHash('sha256');for(const record of records)digest.update(record);
   return 'sha256:'+digest.digest('hex')};
 const sealsTree=async(root,tree)=>{try{const m=JSON.parse(await f.readFile(p.join(root,'provider-pack.json'),'utf8'));
   return Object.values({...m.payload?.providers,...m.payload?.candidateProviders}).some(x=>x?.path===tree.path&&x?.sha256===tree.sha256)}catch{return false}};
 for(const tree of trees){
   for(const root of roots){try{
     if(!await sealsTree(root,tree))continue;
     const source=p.join(root,tree.path),s=await f.lstat(source);
     if(!s.isDirectory()||!protectedEntry(s)||!await protectedAncestors(source)||await treeHash(source)!==tree.sha256)continue;
     const target=p.join(spec.target,tree.path);await f.mkdir(p.dirname(target),{recursive:true,mode:448});
     await f.symlink(source,target);linkedTrees.push(tree.path);break;
   }catch{}}
 }
 const regularPath=async(root,relative)=>{
   let current=root;if(!(await f.lstat(current)).isDirectory())return false;
   const parts=relative.split('/');
   for(let i=0;i<parts.length;i++){current=p.join(current,parts[i]);const s=await f.lstat(current);
     if(i===parts.length-1?!s.isFile():!s.isDirectory())return false;}
   return true;
 };
 const link=async(entry,target)=>{
   if(/\\.[cm]?js$/.test(entry.path)||trees.some(tree=>under(entry.path,tree.path)))return false;
   for(const root of roots){try{
     const source=p.join(root,entry.path);if(!await regularPath(root,entry.path))continue;
     const s=await f.lstat(source);
     if(s.size!==entry.bytes||!protectedEntry(s)||(s.mode&365)!==(entry.mode&365)||!await protectedAncestors(source))continue;
     if(fileHash(source)!==entry.sha256)continue;
     await f.mkdir(p.dirname(target),{recursive:true,mode:448});await f.symlink(source,target);return true;
   }catch{}}
   return false;
 };
 for(const [index,entry] of spec.files.entries()){
   if(linkedTrees.some(tree=>under(entry.path,tree)))continue;
   const target=p.join(spec.target,entry.path);let reused=false;
   const copy=copies.get(entry.sha256);
   if(copy&&copy.mode===entry.mode){try{await f.mkdir(p.dirname(target),{recursive:true,mode:448});await f.link(copy.path,target);continue}catch{}}
   if(await link(entry,target))continue;
   // A large file can repeat at another path, so the same bytes are reusable from there.
   const sources=[entry.path,...spec.files.filter(other=>other.sha256===entry.sha256&&other.path!==entry.path).map(other=>other.path)];
   for(const root of roots){for(const relative of sources){try{
     if(!await regularPath(root,relative))continue;
     const source=p.join(root,relative);if((await f.lstat(source)).size!==entry.bytes)continue;
     await f.mkdir(p.dirname(target),{recursive:true,mode:448});
     await f.copyFile(source,target,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
     if((await f.lstat(target)).size!==entry.bytes||fileHash(target)!==entry.sha256)throw Error('digest mismatch');
     await f.chmod(target,entry.mode);reused=true;break;
   }catch{await f.unlink(target).catch(()=>{});}}if(reused)break;}
   if(reused)copies.set(entry.sha256,{path:target,mode:entry.mode});
   else missing.push(index);
 }
 console.log(JSON.stringify({missing,linkedTrees}));
})().catch(()=>process.exitCode=1);
`;

export function providerPackLayersArgument(archive: ProviderPackLayers, targetPath: string, reuseRoots: readonly string[],
  trees: readonly ProviderPackTree[] = [], runUid?: number) {
  const spec = Buffer.from(JSON.stringify({ target: targetPath, roots: reuseRoots, files: archive.files, trees,
    ...(runUid === undefined ? {} : { runUid }) })).toString("base64");
  return Buffer.byteLength(spec) > 120_000 ? null : spec;
}

const safeRelativePath = (path: string) => !!path && path.length <= 4096 && !path.startsWith("/")
  && !path.includes("\\") && !path.includes("\0") && !path.split("/").some(part => !part || part === "." || part === "..");

/** The provider asset trees a pack manifest seals, for linking from an image pack. */
export function providerPackTrees(manifest: { payload?: { providers?: unknown; candidateProviders?: unknown } } | undefined): ProviderPackTree[] {
  const entries = Object.values({ ...(manifest?.payload?.providers as object | undefined), ...(manifest?.payload?.candidateProviders as object | undefined) });
  const trees = new Map<string, ProviderPackTree>();
  for (const entry of entries as Array<{ path?: unknown; sha256?: unknown } | null>) {
    if (typeof entry?.path === "string" && safeRelativePath(entry.path)
      && typeof entry.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(entry.sha256)) {
      trees.set(entry.path, { path: entry.path, sha256: entry.sha256 });
    }
  }
  // Nested trees cannot be linked independently.
  return [...trees.values()].filter(tree => ![...trees.keys()].some(other =>
    other !== tree.path && (tree.path.startsWith(`${other}/`) || other.startsWith(`${tree.path}/`))));
}

export async function stageProviderPackLayers(input: {
  archive: ProviderPackLayers;
  runner: CommandManagedRuntimeRunner;
  targetPath: string;
  reuseRoots: readonly string[];
  /** Provider asset trees the selected manifest seals; whole trees may link to an image pack. */
  trees?: readonly ProviderPackTree[];
  /** The remote run user; tests set another user so local files count as protected. */
  runUid?: number;
  trace?: NativeRunTrace;
}): Promise<boolean> {
  const { archive, runner } = input;
  const trees = input.trees ?? [];
  if (!runner.syncIn) throw Error("runner_remote_provider_archive_transport_unavailable");
  const measure = <T>(name: string, fn: () => Promise<T>) => input.trace ? input.trace.measure(name, fn) : fn();
  const spec = providerPackLayersArgument(archive, input.targetPath, input.reuseRoots, trees, input.runUid);
  // Respect the per-argument Linux limit; unusual packs retain directory staging.
  if (spec === null) return false;
  const capability = await measure("provider_pack.archive.probe", () => runner.execute({
    command: "sh", args: ["-c", `${providerPackExtractionProbe} && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)'`],
    bypassSession: true, timeoutMs: 10_000,
  }));
  if (capability.exitCode !== 0 || capability.timedOut) return false;
  const reused = await measure("provider_pack.archive.reuse", () => runner.execute({
    command: "node", args: ["-e", reuseScript, spec], bypassSession: true, timeoutMs: 60_000,
  }));
  if (reused.exitCode !== 0 || reused.timedOut) throw Error("runner_remote_provider_archive_reuse_failed");
  let missing: number[], linkedTrees: string[];
  try { ({ missing, linkedTrees } = JSON.parse(reused.stdout)); } catch { throw Error("runner_remote_provider_archive_reuse_failed"); }
  const linked = (path: string) => linkedTrees.some(tree => path === tree || path.startsWith(`${tree}/`));
  if (!Array.isArray(missing) || new Set(missing).size !== missing.length
    || missing.some(index => !Number.isSafeInteger(index) || index < 0 || index >= archive.files.length)
    || !Array.isArray(linkedTrees) || new Set(linkedTrees).size !== linkedTrees.length
    || linkedTrees.some(tree => !trees.some(expected => expected.path === tree))
    || missing.some(index => linked(archive.files[index]!.path))) {
    throw Error("runner_remote_provider_archive_reuse_failed");
  }
  const layers = [
    ...missing.map(index => ({ name: `${index}.tar.zst`, ...archive.files[index]!.archive })),
    { name: "overlay.tar.zst", ...archive.overlay },
  ];
  const temporary = await mkdtemp(join(tmpdir(), "paperclip-provider-layers-"));
  const bundlePath = join(temporary, "selected.tar.zst");
  const scratch = `${input.targetPath}.upload-${randomUUID()}`;
  const remoteArchive = `${scratch}/selected.tar.zst`;
  try {
    // Concatenate independent zstd frames without recompression. One upload
    // avoids a provider round trip for every small missing layer.
    const hash = createHash("sha256");
    await measure("provider_pack.archive.verify_missing", () => pipeline((async function* () {
      for (const layer of layers) {
        const file = await open(`${archive.sourceRoot}/${layer.name}`, constants.O_RDONLY | constants.O_NOFOLLOW)
          .catch(error => { throw invalidArchive("archive_unreadable", error); });
        try {
          const metadata = await file.stat(), layerHash = createHash("sha256");
          if (!metadata.isFile() || metadata.size !== layer.bytes) throw invalidArchive("size_mismatch");
          for await (const chunk of file.createReadStream({ autoClose: false })) {
            layerHash.update(chunk); hash.update(chunk); yield chunk;
          }
          if (layerHash.digest("hex") !== layer.sha256) throw invalidArchive("sha256_mismatch");
        } finally { await file.close(); }
      }
    })(), createWriteStream(bundlePath, { flags: "wx", mode: 0o600 })));
    const sha256 = hash.digest("hex");
    await measure("provider_pack.archive.transfer", () => runner.syncIn!([{
      operationId: `runner-provider-layers-${randomUUID()}`,
      files: [{ kind: "file", sourcePath: bundlePath, targetPath: remoteArchive, mode: 0o600 }],
    }]));
    const result = await measure("provider_pack.archive.extract", () => runner.execute({
      command: "sh", args: ["-c", ["set -eu; umask 077;",
        `test ! -L ${quote(input.targetPath)}; test -d ${quote(input.targetPath)};`,
        `test ! -L ${quote(remoteArchive)}; test "$(sha256sum -- ${quote(remoteArchive)} | cut -d ' ' -f 1)" = ${quote(sha256)};`,
        // A linked tree is a symlink to the image pack; never extract through it.
        `tar --zstd --ignore-zeros -xf ${quote(remoteArchive)} --no-same-owner --same-permissions --delay-directory-restore`,
        ...linkedTrees.map(tree => `--anchored --no-wildcards --exclude=${quote(`./${tree}`)}`),
        `-C ${quote(input.targetPath)};`,
        `chmod 700 ${quote(input.targetPath)};`,
      ].join(" ")], bypassSession: true, timeoutMs: 120_000,
    }));
    if (result.exitCode !== 0 || result.timedOut) throw Error("runner_remote_provider_archive_extract_failed");
    return true;
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await runner.execute({ command: "sh", args: ["-c", `rm -rf -- ${quote(scratch)}`],
      bypassSession: true, timeoutMs: 10_000 }).catch(() => undefined);
  }
}
