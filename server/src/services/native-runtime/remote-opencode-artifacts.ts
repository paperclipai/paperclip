import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeProviderArtifactReceipt } from "./native-provider-artifacts.js";
import type { ProviderPackIdentity } from "./remote-provider-pack-verification.js";

const names = ["nodeCommand", "opencodeProxy", "opencodeExecutable"] as const;
export type OpenCodeLaunchArtifacts = {
  root: string;
  accountUid: number;
  paths: Record<(typeof names)[number], string>;
};

const accountProbe = `const os=require('node:os');const a=os.userInfo();process.stdout.write(JSON.stringify({home:a.homedir,uid:a.uid}));`;
const prepare = String.raw`
const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
const x=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
const bad=()=>{throw Error('native_provider_artifacts_remote_unsafe')};
const checkDir=(d)=>{const s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==x.uid||(s.mode&0o022))bad()};
let current='/';for(const part of x.home.split('/').filter(Boolean)){current=p.join(current,part);const s=fs.lstatSync(current);if(s.isSymbolicLink()||!s.isDirectory())bad()}
checkDir(x.home);
for(const part of ['.paperclip-runtime','paperclip-runner','provider-artifacts']){current=p.join(current,part);try{fs.mkdirSync(current,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}checkDir(current)}
if(p.join(current,x.digest)!==x.root)bad();
if(x.mode==='cleanup'){try{checkDir(x.pending);fs.rmSync(x.pending,{recursive:true})}catch(e){if(e.code!=='ENOENT')throw e}process.exit(0)}
const hash=(f,expected)=>{const fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const a=fs.fstatSync(fd);if(!a.isFile()||a.size>512*1024*1024)bad();const h=c.createHash('sha256'),b=Buffer.alloc(1024*1024);let n,total=0;while((n=fs.readSync(fd,b,0,b.length,null))){total+=n;h.update(b.subarray(0,n))}const z=fs.fstatSync(fd);if(total!==a.size||a.ino!==z.ino||a.size!==z.size||a.mtimeMs!==z.mtimeMs||a.ctimeMs!==z.ctimeMs||'sha256:'+h.digest('hex')!==expected)bad()}finally{fs.closeSync(fd)}};
const confinedSource=(root,relative)=>{
 root=fs.realpathSync(root);let current=root,parts=relative.split('/'),links=0;
 while(parts.length){current=p.join(current,parts.shift());const s=fs.lstatSync(current);
  if(s.isSymbolicLink()){
   if(++links>32)bad();const target=p.resolve(p.dirname(current),fs.readlinkSync(current));
   if(target!==root&&!target.startsWith(root+p.sep))bad();
   parts=(target===root?[]:p.relative(root,target).split('/')).concat(parts);current=root;
  }else if(parts.length&&!s.isDirectory())bad();
 }
 return current;
};
const copyQualified=(source,target,expected,limit)=>{
 const input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let output;
 try{const before=fs.fstatSync(input);if(!before.isFile()||before.size>limit)bad();
  output=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o500);
  const h=c.createHash('sha256'),b=Buffer.alloc(1024*1024);let n,total=0;
  while((n=fs.readSync(input,b,0,b.length,null))){if((total+=n)>before.size)bad();h.update(b.subarray(0,n));let written=0;while(written<n)written+=fs.writeSync(output,b,written,n-written)}
  const after=fs.fstatSync(input);if(total!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||'sha256:'+h.digest('hex')!==expected)bad();
  return total;
 }finally{fs.closeSync(input);if(output!==undefined)fs.closeSync(output)}
};
const verify=(root)=>{checkDir(root);let total=0;for(const e of x.entries){let d=root;const parts=e.path.split('/');for(const part of parts.slice(0,-1)){d=p.join(d,part);checkDir(d)}const f=p.join(root,e.path),s=fs.lstatSync(f);if(s.isSymbolicLink()||!s.isFile()||s.uid!==x.uid||(s.mode&0o022)||(total+=s.size)>512*1024*1024)bad();hash(f,e.sha256);if(e.name!=='opencodeProxy'){const fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),b=Buffer.alloc(4);try{if(fs.readSync(fd,b,0,4,0)!==4||b.toString('hex')!=='7f454c46')bad()}finally{fs.closeSync(fd)}}}};
if(x.mode==='inspect'){try{verify(x.root);process.stdout.write('ready')}catch(e){if(e.code!=='ENOENT')throw e}process.exit(0)}
if(x.mode==='publish'){verify(x.pending);try{fs.renameSync(x.pending,x.root)}catch(e){if(e.code!=='EEXIST'&&e.code!=='ENOTEMPTY')throw e;verify(x.root);fs.rmSync(x.pending,{recursive:true})}verify(x.root);process.exit(0)}
try{fs.mkdirSync(x.pending,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}checkDir(x.pending);
let total=0;for(const e of x.entries){let d=x.pending;for(const part of e.path.split('/').slice(0,-1)){d=p.join(d,part);try{fs.mkdirSync(d,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}checkDir(d)}
 if(x.source){const src=confinedSource(x.source,e.path);total+=copyQualified(src,p.join(x.pending,e.path),e.sha256,512*1024*1024-total)}}
`;

export async function prepareRemoteOpenCodeArtifacts(input: {
  runner: CommandManagedRuntimeRunner;
  bootstrapNode: string;
  manifest: ProviderPackIdentity;
  nonce: string;
  sourceRoot?: string;
  restored?: { receipt: NativeProviderArtifactReceipt; directory: string };
  stageFile: (input: {
    sourcePath: string;
    targetPath: string;
    mode: number;
  }) => Promise<void>;
}): Promise<OpenCodeLaunchArtifacts> {
  if (
    !/^[a-f0-9-]{36}$/.test(input.nonce) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.manifest.digest)
  )
    throw new Error("native_provider_artifacts_manifest_invalid");
  const run = async (args: string[]) => {
    const result = await input.runner.execute({
      command: input.bootstrapNode,
      args,
      bypassSession: true,
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error("native_provider_artifacts_remote_unavailable");
    return result.stdout;
  };
  const account = JSON.parse(await run(["-e", accountProbe]));
  if (
    typeof account.home !== "string" ||
    !posix.isAbsolute(account.home) ||
    account.home === "/" ||
    posix.normalize(account.home) !== account.home ||
    /[\\\u0000-\u001f\u007f]/u.test(account.home) ||
    !Number.isSafeInteger(account.uid) ||
    account.uid < 0
  )
    throw new Error("native_provider_artifacts_account_invalid");
  const root = posix.join(
    account.home,
    ".paperclip-runtime/paperclip-runner/provider-artifacts",
    input.manifest.digest.slice(7),
  );
  if (
    input.restored &&
    (input.restored.receipt.accountUid !== account.uid ||
      input.restored.receipt.launchRoot !== root ||
      input.restored.receipt.providerPackDigest !== input.manifest.digest)
  ) {
    throw new Error("native_provider_artifacts_account_changed");
  }
  const entries = names.map((name) => {
    const e = input.manifest.payload.artifacts[name];
    if (
      !e ||
      !/^[a-zA-Z0-9._/-]+$/.test(e.path) ||
      e.path.split("/").some((p) => !p || p === "." || p === "..") ||
      posix.isAbsolute(e.path) ||
      !/^sha256:[a-f0-9]{64}$/.test(e.sha256)
    )
      throw new Error("native_provider_artifacts_manifest_invalid");
    return { name, ...e };
  });
  const pending = `${root}.${input.nonce}.pending`;
  const command = (mode: string) => [
    "-e",
    prepare,
    Buffer.from(
      JSON.stringify({
        ...account,
        root,
        pending,
        digest: input.manifest.digest.slice(7),
        entries,
        source: input.restored ? null : input.sourceRoot,
        mode,
      }),
    ).toString("base64"),
  ];
  if ((await run(command("inspect"))) !== "ready") {
    if (!input.restored && !input.sourceRoot)
      throw new Error("native_provider_artifacts_source_missing");
    try {
      await run(command("prepare"));
      if (input.restored)
        for (const entry of entries)
          await input.stageFile({
            sourcePath: posix.join(input.restored.directory, entry.name),
            targetPath: posix.join(pending, entry.path),
            mode: 0o500,
          });
      await run(command("publish"));
    } catch (error) {
      await run(command("cleanup")).catch(() => undefined);
      throw error;
    }
  }
  return {
    root,
    accountUid: account.uid,
    paths: Object.fromEntries(
      entries.map((e) => [e.name, posix.join(root, e.path)]),
    ) as OpenCodeLaunchArtifacts["paths"],
  };
}
