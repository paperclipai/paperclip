// Test-only reviewed SDK reference. Actual CI builds may use an unreviewed
// resolved lock; neither this fixture nor production admits that as public proof.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import pins from "./source-sdk-public-inputs.json" with { type: "json" };
import { prepareReportLock } from "./prepare-report-lock.mjs";
import { verifySdkPublicSource } from "./source-sdk-public-type.js";
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const blob=(bytes:Buffer)=>createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const gitFile=(root:string,file:string)=>execFileSync("git",["show",`HEAD:${file}`],{cwd:root,maxBuffer:8*1024*1024,stdio:["ignore","pipe","pipe"]});

// Create owned directories, link only read-only installed third-party inputs.
// Never link workspace compiled exports or donor node_modules/.cache: the
// normal producer's lock and every Shared/SDK emit stay in this fixture root.
async function thirdPartyLinks(from:string,to:string,installedStore:string){
  const link=async(source:string,destination:string)=>{
    const target=await realpath(source);
    // A local workspace may have an unscoped name too. Admit only installed
    // third-party store entries, never another checkout/package's exports.
    if(target!==installedStore&&!target.startsWith(installedStore+path.sep))return;
    await symlink(target,destination);
  };
  await mkdir(to,{recursive:true});
  for(const entry of await readdir(from,{withFileTypes:true})){
    if([".cache",".bin","@paperclipai"].includes(entry.name))continue;
    const source=path.join(from,entry.name),destination=path.join(to,entry.name);
    if(entry.name.startsWith("@")){
      await mkdir(destination,{recursive:true});
      for(const child of await readdir(source))await link(path.join(source,child),path.join(destination,child));
    }else await link(source,destination);
  }
}
export async function prepareReviewedSdkReference(original:string,directory:string){
  if(await realpath(directory)!==directory||(await readdir(directory)).length!==0)throw new Error("Reviewed SDK reference needs a fresh owned directory");
  const policyFile="tests/runner-e2e/report-lock.json",patchFile="tests/runner-e2e/report-lock.patch";
  const policyBytes=gitFile(original,policyFile),policy=JSON.parse(policyBytes.toString("utf8"));
  if(!(await readFile(path.join(original,policyFile))).equals(policyBytes)||policy.outputSha256!==pins.lockSha256)
    throw new Error("Reviewed SDK reference policy does not match public proof: source-sdk-public-inputs.json lockSha256 must equal the committed report-lock.json outputSha256. "
      +"Commit the lock change, then run `node tests/runner-e2e/source-sdk-public-inputs.mjs $(git rev-parse HEAD) --write` and commit the updated registry.");
  const committed=gitFile(original,"pnpm-lock.yaml");
  if(![policy.inputSha256,policy.outputSha256].includes(sha(committed)))throw new Error("Committed SDK reference lock is not reviewed");
  for(const [file,expected]of Object.entries(pins.inputs)){
    const bytes=file==="pnpm-lock.yaml"?committed:await readFile(path.join(original,file));
    if(file!=="pnpm-lock.yaml"&&blob(bytes)!==expected)throw new Error("Reviewed SDK reference source changed");
    const target=path.join(directory,file);await mkdir(path.dirname(target),{recursive:true});
    if(file==="pnpm-lock.yaml")await writeFile(target,bytes);else await copyFile(path.join(original,file),target);
  }
  for(const file of [policyFile,patchFile]){
    const bytes=gitFile(original,file);
    if(!(await readFile(path.join(original,file))).equals(bytes))throw new Error("Reviewed SDK lock policy changed");
    const target=path.join(directory,file);await mkdir(path.dirname(target),{recursive:true});
    await writeFile(target,bytes);
  }
  // Same existing authenticated input->output correction. No hash refresh,
  // changed-lock admission, install, resolver or compiler-option substitution.
  await prepareReportLock(directory);
  if(sha(await readFile(path.join(directory,"pnpm-lock.yaml")))!==policy.outputSha256)throw new Error("Reviewed SDK reference lock changed");
  const installedStore=await realpath(path.join(original,"node_modules/.pnpm"));
  await thirdPartyLinks(path.join(original,"node_modules"),path.join(directory,"node_modules"),installedStore);
  for(const name of ["shared","plugins/sdk"])await thirdPartyLinks(path.join(original,"packages",name,"node_modules"),path.join(directory,"packages",name,"node_modules"),installedStore);
  for(const modules of ["node_modules","packages/plugins/sdk/node_modules"]){
    const scope=path.join(directory,modules,"@paperclipai");await mkdir(scope,{recursive:true});
    await symlink(path.join(directory,"packages/shared"),path.join(scope,"shared"));
  }
  const require=createRequire(path.join(directory,"packages/plugins/sdk/package.json"));
  const sharedEntry=await realpath(require.resolve("@paperclipai/shared"));
  if(!sharedEntry.startsWith(path.join(directory,"packages/shared")+path.sep))throw new Error("SDK reference resolved a donor workspace");
  // Authenticate original compiler/parser/Zod/source pins BEFORE normal build.
  await verifySdkPublicSource(directory);
}
