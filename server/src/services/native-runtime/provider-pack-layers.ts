import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeRunTrace } from "./native-run-trace.js";
import {
  isProviderAssetPathIncluded,
  providerAssetExcludeArgs,
  requiredProviderAssetNames,
  type PackProvider,
  type ProviderPackIdentity,
} from "./provider-pack-compatibility.js";
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

// Copy first, then hash the private copy: no mutation of the older image, and
// no time-of-check/time-of-use trust in its contents. Image bytes are never
// linked, because the runner requires its pack to be physical files inside the
// pack. Only verified private copies inside the pack are hardlinked, and only
// to files with the same digest and mode. `providerPackReusePlan` decides how repeated bytes
// are stored once; this program only follows that plan.
const reuseScript = `
(async()=>{
 const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
 const spec=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
 const f=fs.promises;await f.mkdir(p.dirname(spec.target),{recursive:true,mode:448});
 await f.mkdir(spec.target,{mode:448});
 const missing=[],anchors=new Map();
 const regularPath=async(root,relative)=>{
   let current=root;if(!(await f.lstat(current)).isDirectory())return false;
   const parts=relative.split('/');
   for(let i=0;i<parts.length;i++){current=p.join(current,parts[i]);const s=await f.lstat(current);
     if(i===parts.length-1?!s.isFile():!s.isDirectory())return false;}
   return true;
 };
 for(const [index,entry] of spec.files.entries()){
   const target=p.join(spec.target,entry.path);let reused=false;
   const anchor=anchors.get(entry.group);
   if(anchor!==undefined){try{
     await f.mkdir(p.dirname(target),{recursive:true,mode:448});await f.link(anchor,target);continue;
   }catch{await f.unlink(target).catch(()=>{});}}
   for(const root of spec.roots){for(const relative of entry.sources){try{
     if(!await regularPath(root,relative))continue;
     const source=p.join(root,relative);if((await f.lstat(source)).size!==entry.bytes)continue;
     await f.mkdir(p.dirname(target),{recursive:true,mode:448});
     await f.copyFile(source,target,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
     const handle=await f.open(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
     let matches=false;try{const hash=c.createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
       matches=(await handle.stat()).size===entry.bytes&&hash.digest('hex')===entry.sha256;
     }finally{await handle.close();}
     if(!matches)throw Error('digest mismatch');
     await f.chmod(target,entry.mode);reused=true;break;
   }catch{await f.unlink(target).catch(()=>{});}}if(reused)break;}
   if(reused)anchors.set(entry.group,target);
   else missing.push(index);
 }
 console.log(JSON.stringify(missing));
})().catch(()=>process.exitCode=1);
`;

export type ProviderPackReuseStep = {
  /** Image paths to copy these bytes from, own path first, then other paths with the same bytes. */
  sources: string[];
  /** Files with the same bytes and mode share a group; later files hardlink to the group's first private copy. */
  group: number;
};

/** Store repeated bytes once: the first private copy of each digest and mode is
 * shared by hardlinks, and a path the image lacks may come from a same-bytes twin. */
export function providerPackReusePlan(
  files: readonly Pick<FileLayer, "path" | "sha256" | "mode">[],
  sourceFiles: readonly Pick<FileLayer, "path" | "sha256">[] = files,
): ProviderPackReuseStep[] {
  const pathsBySha = new Map<string, string[]>();
  for (const file of sourceFiles) pathsBySha.set(file.sha256, [...(pathsBySha.get(file.sha256) ?? []), file.path]);
  const groups = new Map<string, number>();
  return files.map(file => {
    const key = `${file.sha256}:${file.mode}`;
    if (!groups.has(key)) groups.set(key, groups.size);
    const twins = (pathsBySha.get(file.sha256) ?? []).filter(path => path !== file.path);
    return { sources: [file.path, ...twins], group: groups.get(key)! };
  });
}

type SelectedFileLayer = { file: FileLayer; index: number };

function selectProviderPackFiles(
  files: readonly FileLayer[],
  required: readonly string[] | null,
  options?: { assetsOnly?: boolean },
): SelectedFileLayer[] {
  return files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => isProviderAssetPathIncluded(file.path, required, options));
}

function buildProviderPackLayersSpec(
  archive: ProviderPackLayers,
  targetPath: string,
  reuseRoots: readonly string[],
  provider?: PackProvider,
  manifest?: Pick<ProviderPackIdentity, "payload">,
  options?: { assetsOnly?: boolean },
): { spec: string | null; selectedEntries: SelectedFileLayer[]; required: string[] | null } {
  const required = requiredProviderAssetNames(provider, manifest);
  const selectedEntries = selectProviderPackFiles(archive.files, required, options);
  const selectedFiles = selectedEntries.map(entry => entry.file);
  const plan = providerPackReusePlan(selectedFiles, archive.files);
  const files = selectedFiles.map((file, index) => ({ ...file, ...plan[index] }));
  const spec = Buffer.from(JSON.stringify({ target: targetPath, roots: reuseRoots, files })).toString("base64");
  return { spec: Buffer.byteLength(spec) > 120_000 ? null : spec, selectedEntries, required };
}

export function providerPackLayersArgument(
  archive: ProviderPackLayers,
  targetPath: string,
  reuseRoots: readonly string[],
  provider?: PackProvider,
  manifest?: Pick<ProviderPackIdentity, "payload">,
) {
  return buildProviderPackLayersSpec(archive, targetPath, reuseRoots, provider, manifest).spec;
}

export async function stageProviderPackLayers(input: {
  archive: ProviderPackLayers;
  runner: CommandManagedRuntimeRunner;
  targetPath: string;
  reuseRoots: readonly string[];
  trace?: NativeRunTrace;
  provider?: PackProvider;
  manifest?: Pick<ProviderPackIdentity, "payload">;
  /** When true, add only the required `provider-assets/<name>` subtrees into an existing verified pack. */
  supplementAssetsOnly?: boolean;
}): Promise<boolean> {
  const { archive, runner } = input;
  if (!runner.syncIn) throw Error("runner_remote_provider_archive_transport_unavailable");
  const measure = <T>(name: string, fn: () => Promise<T>) => input.trace ? input.trace.measure(name, fn) : fn();
  const supplement = input.supplementAssetsOnly === true;
  const stageDir = supplement ? `${input.targetPath}.assets-${randomUUID()}` : input.targetPath;
  const { spec, selectedEntries, required } = buildProviderPackLayersSpec(
    archive,
    stageDir,
    input.reuseRoots,
    input.provider,
    input.manifest,
    supplement ? { assetsOnly: true } : undefined,
  );
  if (supplement && (!required || required.length === 0)) return false;
  // Respect the per-argument Linux limit; unusual packs retain directory staging.
  if (spec === null) return false;
  const capability = await measure("provider_pack.archive.probe", () => runner.execute({
    command: "sh", args: ["-c", `${providerPackExtractionProbe} && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)'`],
    bypassSession: true, timeoutMs: 10_000,
  }));
  if (capability.exitCode !== 0 || capability.timedOut) return false;
  const scratch = `${input.targetPath}.upload-${randomUUID()}`;
  const temporary = await mkdtemp(join(tmpdir(), "paperclip-provider-layers-"));
  const bundlePath = join(temporary, "selected.tar.zst");
  const remoteArchive = `${scratch}/selected.tar.zst`;
  try {
    const reused = await measure("provider_pack.archive.reuse", () => runner.execute({
      command: "node", args: ["-e", reuseScript, spec], bypassSession: true, timeoutMs: 60_000,
    }));
    if (reused.exitCode !== 0 || reused.timedOut) throw Error("runner_remote_provider_archive_reuse_failed");
    let missing: number[];
    try { missing = JSON.parse(reused.stdout); } catch { throw Error("runner_remote_provider_archive_reuse_failed"); }
    if (!Array.isArray(missing) || new Set(missing).size !== missing.length
      || missing.some(index => !Number.isSafeInteger(index) || index < 0 || index >= selectedEntries.length)) {
      throw Error("runner_remote_provider_archive_reuse_failed");
    }
    const layers = [
      ...missing.map(selectedIndex => {
        const entry = selectedEntries[selectedIndex]!;
        return { name: `${entry.index}.tar.zst`, ...entry.file.archive };
      }),
      { name: "overlay.tar.zst", ...archive.overlay },
    ];
    const excludeFlags = providerAssetExcludeArgs({
      provider: input.provider,
      manifest: input.manifest,
      filePaths: archive.files.map(file => file.path),
    }).map(quote).join(" ");
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
    const installCommands = supplement
      ? [
          `test ! -L ${quote(input.targetPath)}; test -d ${quote(input.targetPath)};`,
          `mkdir -p ${quote(`${input.targetPath}/provider-assets`)};`,
          `test ! -L ${quote(`${input.targetPath}/provider-assets`)};`,
          ...required!.map(name => [
            `test -d ${quote(`${stageDir}/provider-assets/${name}`)};`,
            `test ! -L ${quote(`${stageDir}/provider-assets/${name}`)};`,
            `rm -rf -- ${quote(`${input.targetPath}/provider-assets/${name}`)};`,
            `mv -- ${quote(`${stageDir}/provider-assets/${name}`)} ${quote(`${input.targetPath}/provider-assets/${name}`)};`,
          ].join(" ")),
        ]
      : [`chmod 700 ${quote(input.targetPath)};`];
    const result = await measure("provider_pack.archive.extract", () => runner.execute({
      command: "sh", args: ["-c", ["set -eu; umask 077;",
        `test ! -L ${quote(stageDir)}; test -d ${quote(stageDir)};`,
        `test ! -L ${quote(remoteArchive)}; test "$(sha256sum -- ${quote(remoteArchive)} | cut -d ' ' -f 1)" = ${quote(sha256)};`,
        `tar --zstd --ignore-zeros${excludeFlags ? ` ${excludeFlags}` : ""} -xf ${quote(remoteArchive)} --no-same-owner --same-permissions --delay-directory-restore -C ${quote(stageDir)};`,
        ...installCommands,
      ].join(" ")], bypassSession: true, timeoutMs: 120_000,
    }));
    if (result.exitCode !== 0 || result.timedOut) throw Error("runner_remote_provider_archive_extract_failed");
    return true;
  } finally {
    await rm(temporary, { recursive: true, force: true });
    const cleanupPaths = supplement ? `${quote(scratch)} ${quote(stageDir)}` : quote(scratch);
    await runner.execute({ command: "sh", args: ["-c", `rm -rf -- ${cleanupPaths}`],
      bypassSession: true, timeoutMs: 10_000 }).catch(() => undefined);
  }
}
