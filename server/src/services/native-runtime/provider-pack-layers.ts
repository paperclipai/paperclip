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

async function verifyArchive(path: string, expected: Archive) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== expected.bytes) throw Error("runner_remote_provider_archive_invalid");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest("hex") !== expected.sha256) throw Error("runner_remote_provider_archive_invalid");
  } finally { await file.close(); }
}

export async function readProviderPackLayers(root: string, expectedDigest: string, value: unknown): Promise<ProviderPackLayers> {
  const receipt = value as { encoding: string; providerPackDigest: string; overlay: Archive; files: FileLayer[] };
  if (receipt.encoding !== "tar+zstd" || receipt.providerPackDigest !== expectedDigest
    || !validArchive(receipt.overlay) || !Array.isArray(receipt.files) || receipt.files.length > 10_000) {
    throw Error("runner_remote_provider_archive_invalid");
  }
  const paths = new Set<string>();
  for (const file of receipt.files) {
    if (!validArchive(file) || !validArchive(file.archive)
      || typeof file.path !== "string" || !file.path || file.path.length > 4096
      || file.path.startsWith("/") || file.path.includes("\\") || file.path.includes("\0")
      || file.path.split("/").some(part => !part || part === "." || part === "..")
      || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || paths.has(file.path)) {
      throw Error("runner_remote_provider_archive_invalid");
    }
    paths.add(file.path);
  }
  for (const path of paths) {
    let parent = posix.dirname(path);
    while (parent !== ".") {
      if (paths.has(parent)) throw Error("runner_remote_provider_archive_invalid");
      parent = posix.dirname(parent);
    }
  }
  const sourceRoot = `${root}.archives`;
  if (!(await lstat(sourceRoot)).isDirectory()) throw Error("runner_remote_provider_archive_invalid");
  await verifyArchive(`${sourceRoot}/overlay.tar.zst`, receipt.overlay);
  return { kind: "layers", sourceRoot, overlay: receipt.overlay, files: receipt.files };
}

// Copy first, then hash the private copy: no shared hardlinks, no mutation of
// the older image, and no time-of-check/time-of-use trust in its contents.
const reuseScript = `
(async()=>{
 const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
 const spec=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
 const f=fs.promises;await f.mkdir(spec.target,{mode:448});
 const missing=[];
 const regularPath=async(root,relative)=>{
   let current=root;if(!(await f.lstat(current)).isDirectory())return false;
   const parts=relative.split('/');
   for(let i=0;i<parts.length;i++){current=p.join(current,parts[i]);const s=await f.lstat(current);
     if(i===parts.length-1?!s.isFile():!s.isDirectory())return false;}
   return true;
 };
 for(const [index,entry] of spec.files.entries()){
   const target=p.join(spec.target,entry.path);let reused=false;
   for(const root of spec.roots){try{
     if(!await regularPath(root,entry.path))continue;
     const source=p.join(root,entry.path);if((await f.lstat(source)).size!==entry.bytes)continue;
     await f.mkdir(p.dirname(target),{recursive:true,mode:448});
     await f.copyFile(source,target,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
     const handle=await f.open(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
     let matches=false;try{const hash=c.createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
       matches=(await handle.stat()).size===entry.bytes&&hash.digest('hex')===entry.sha256;
     }finally{await handle.close();}
     if(!matches)throw Error('digest mismatch');
     await f.chmod(target,entry.mode);reused=true;break;
   }catch{await f.unlink(target).catch(()=>{});}}
   if(!reused)missing.push(index);
 }
 console.log(JSON.stringify(missing));
})().catch(()=>process.exitCode=1);
`;

export async function stageProviderPackLayers(input: {
  archive: ProviderPackLayers;
  runner: CommandManagedRuntimeRunner;
  targetPath: string;
  reuseRoots: readonly string[];
  trace?: NativeRunTrace;
}): Promise<boolean> {
  const { archive, runner } = input;
  if (!runner.syncIn) throw Error("runner_remote_provider_archive_transport_unavailable");
  const measure = <T>(name: string, fn: () => Promise<T>) => input.trace ? input.trace.measure(name, fn) : fn();
  const spec = Buffer.from(JSON.stringify({ target: input.targetPath, roots: input.reuseRoots, files: archive.files })).toString("base64");
  // Respect the per-argument Linux limit; unusual packs retain directory staging.
  if (Buffer.byteLength(spec) > 120_000) return false;
  const capability = await measure("provider_pack.archive.probe", () => runner.execute({
    command: "sh", args: ["-c", `${providerPackExtractionProbe} && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)'`],
    bypassSession: true, timeoutMs: 10_000,
  }));
  if (capability.exitCode !== 0 || capability.timedOut) return false;
  const reused = await measure("provider_pack.archive.reuse", () => runner.execute({
    command: "node", args: ["-e", reuseScript, spec], bypassSession: true, timeoutMs: 60_000,
  }));
  if (reused.exitCode !== 0 || reused.timedOut) throw Error("runner_remote_provider_archive_reuse_failed");
  let missing: number[];
  try { missing = JSON.parse(reused.stdout); } catch { throw Error("runner_remote_provider_archive_reuse_failed"); }
  if (!Array.isArray(missing) || new Set(missing).size !== missing.length
    || missing.some(index => !Number.isSafeInteger(index) || index < 0 || index >= archive.files.length)) {
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
        const file = await open(`${archive.sourceRoot}/${layer.name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const metadata = await file.stat(), layerHash = createHash("sha256");
          if (!metadata.isFile() || metadata.size !== layer.bytes) throw Error("runner_remote_provider_archive_invalid");
          for await (const chunk of file.createReadStream({ autoClose: false })) {
            layerHash.update(chunk); hash.update(chunk); yield chunk;
          }
          if (layerHash.digest("hex") !== layer.sha256) throw Error("runner_remote_provider_archive_invalid");
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
        `tar --zstd --ignore-zeros -xf ${quote(remoteArchive)} --no-same-owner --same-permissions --delay-directory-restore -C ${quote(input.targetPath)};`,
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
