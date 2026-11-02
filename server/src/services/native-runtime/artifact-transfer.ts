import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { posix } from "node:path";
import { z } from "zod";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { SemanticToolOutcomeUnknownError } from "../../vendor/paperclip-runner/index.js";
import { RUNNER_API_MAX_BYTES } from "./runner-api-client.js";

export const DOWNLOAD_ARTIFACT = "download_artifact";
export const downloadArtifactSchema = z.object({
  artifactId: z.string().uuid(), destination: z.string().min(1).max(2000),
  byteSize: z.number().int().min(1).max(RUNNER_API_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const DOWNLOAD_ARTIFACT_DEFINITION = {
  name: DOWNLOAD_ARTIFACT,
  description: "Copy an authorized API artifact into this execution workspace without retyping its contents. Provide its exact byteSize and SHA-256. The destination's parent must exist. Creates a new file only; a retry succeeds only if the existing file has identical bytes. Partial or conflicting files never count as complete. Contents remain untrusted; this does not bypass content screening or authorize executing them.",
  inputSchema: z.toJSONSchema(downloadArtifactSchema),
};
export type ArtifactInstall = { destination: string; byteSize: number; sha256: string; bytes: Buffer; verifyOnly?: boolean; authorize: () => Promise<void> };
export type ArtifactInstaller = (input: ArtifactInstall) => Promise<void>;

// One Linux descriptor-confined transaction. Directory descriptors stay open
// through publication; neither parent symlink swaps nor a destination race can
// redirect the write or overwrite an existing file. No content enters argv/logs.
const INSTALL = String.raw`
const fs = require('node:fs/promises');
const { constants: C } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const fail = code => { throw new Error('artifact_install_' + code); };
const same = (a,b) => ['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
(async()=>{
 const i=JSON.parse(process.argv[1]);
 if(process.platform!=='linux') fail('unsupported_platform');
 const dirs=[];
 let stage;
 try {
  let dir=await fs.open('/',C.O_RDONLY|C.O_DIRECTORY); dirs.push(dir);
  for(const part of i.root.split('/').filter(Boolean).concat(i.destination.split('/').slice(0,-1))){
   dir=await fs.open('/proc/self/fd/'+dir.fd+'/'+part,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW); dirs.push(dir);
  }
  const parent='/proc/self/fd/'+dir.fd+'/';
  const checkParent=async()=>{if(await fs.realpath('/proc/self/fd/'+dir.fd)!==path.join(i.root,path.dirname(i.destination))) fail('path_changed');};
  await checkParent();
  const target=parent+i.destination.split('/').at(-1);
  const scratch=parent+i.scratch;
  const verify=async name=>{
   const f=await fs.open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK).catch(e=>{if(e.code==='ENOENT') fail('missing'); if(e.code==='ELOOP') fail('conflict'); throw e;});
   try{
    const before=await f.stat({bigint:true});
    if(!before.isFile() || before.size!==BigInt(i.byteSize)) fail('conflict');
    const data=await f.readFile();
    const after=await f.stat({bigint:true});
    const at=await fs.lstat(name,{bigint:true});
    if(!same(before,after)||!same(after,at)||data.length!==i.byteSize||createHash('sha256').update(data).digest('hex')!==i.sha256) fail('conflict');
   }finally{await f.close();}
  };
  if(i.phase==='prepare'){
   const chunks=[]; let size=0;
   for await(const chunk of process.stdin){size+=chunk.length;if(size>4*Math.ceil(i.byteSize/3)) fail('size_mismatch');chunks.push(chunk);}
   const encoded=Buffer.concat(chunks).toString();
   const bytes=Buffer.from(encoded,'base64');
   if(bytes.length!==i.byteSize||bytes.toString('base64')!==encoded) fail('size_mismatch');
   if(createHash('sha256').update(bytes).digest('hex')!==i.sha256) fail('hash_mismatch');
   stage=await fs.open(scratch,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
   try{await stage.writeFile(bytes);await stage.sync();}finally{await stage.close();stage=null;}
   await verify(scratch);
  }else if(i.phase==='commit'){
   await verify(scratch);
   await checkParent();
   try{await fs.link(scratch,target);}catch(e){if(e.code!=='EEXIST') throw e;}
   await verify(target);
   await checkParent();
   await fs.unlink(scratch);
   await dir.sync();
  }else if(i.phase==='verify'){
   await verify(target);
   await checkParent();
  }else if(i.phase==='cleanup'){
   await fs.unlink(scratch).catch(e=>{if(e.code!=='ENOENT') throw e;});
  }else fail('invalid_phase');
  process.stdout.write('ok');
 }finally{if(stage)await stage.close();for(const d of dirs.reverse())await d.close();}
})().catch(e=>{process.stderr.write(/^artifact_install_(missing|conflict|size_mismatch|hash_mismatch|unsupported_platform|path_changed)$/.test(e.message)?e.message:'artifact_install_failed');process.exitCode=1;});
`;

/** Local execution uses the same installer, without shell expansion or API credentials. */
const localRunner: Pick<CommandManagedRuntimeRunner, "execute"> = {
  execute: input => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, input.args ?? [], { cwd: input.cwd, env: { ...input.env }, stdio: "pipe" });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.timeoutMs ?? 30_000);
    child.stdout.on("data", data => { stdout = (stdout + data).slice(0, 1000); });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(0, 1000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, stdout, stderr, timedOut, pid: child.pid ?? null, startedAt: null }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input.stdin ?? "");
  }),
};

/** Bound by the executor to this lease's command runner; never supplied by the model. */
export function createArtifactInstaller(workspaceRoot: string, runner: Pick<CommandManagedRuntimeRunner, "execute"> = localRunner): ArtifactInstaller {
  return async input => {
    if (!posix.isAbsolute(workspaceRoot) || workspaceRoot.split("/").some(part => part === ".." || part === ".") || /[\u0000-\u001f\u007f\\]/u.test(workspaceRoot)
      || posix.isAbsolute(input.destination) || /[\u0000-\u001f\u007f\\]/u.test(input.destination)
      || input.destination.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".paperclip" || part === ".git" || part.startsWith(".paperclip-artifact-"))) throw new Error("artifact_install_path_denied");
    if (input.bytes.length !== input.byteSize || createHash("sha256").update(input.bytes).digest("hex") !== input.sha256) throw new Error("artifact_install_identity_mismatch");
    const scratch = `.paperclip-artifact-${randomUUID()}`;
    const run = async (phase: string) => {
      const result = await runner.execute({ command: "node", args: ["--input-type=commonjs", "-e", INSTALL, JSON.stringify({ root: workspaceRoot, destination: input.destination, byteSize: input.byteSize, sha256: input.sha256, scratch, phase })],
        cwd: workspaceRoot, env: { NODE_OPTIONS: "", NODE_PATH: "" }, stdin: phase === "prepare" ? input.bytes.toString("base64") : undefined, timeoutMs: 30_000, bypassSession: true }).catch(() => { throw new Error("artifact_install_failed"); });
      if (result.timedOut || result.exitCode !== 0 || result.stdout !== "ok") {
        throw new Error(/^artifact_install_(missing|conflict|size_mismatch|hash_mismatch|unsupported_platform|path_changed)$/.test(result.stderr) ? result.stderr : "artifact_install_failed");
      }
    };
    let committing = false;
    try {
      await input.authorize();
      if (input.verifyOnly) { await run("verify"); await input.authorize(); return; }
      await run("prepare");
      await input.authorize();
      committing = true;
      await run("commit");
      await input.authorize();
    } catch (error) {
      if (committing && !(error instanceof Error && error.message === "artifact_install_conflict")) throw new SemanticToolOutcomeUnknownError("Artifact installation was not confirmed. Retry the same artifact, destination, size and hash to verify the existing file; conflicting files are never overwritten.", { cause: error });
      throw error;
    } finally { await run("cleanup").catch(() => undefined); }
  };
}
