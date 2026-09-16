import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const verifier=fileURLToPath(new URL('./verify-pi-provider-launch.mjs',import.meta.url));
for(const {ignoreTerm, suppressClose} of [{ignoreTerm:false,suppressClose:false},{ignoreTerm:true,suppressClose:false},{ignoreTerm:false,suppressClose:true}]) test('Pi qualification cleans HOME after bounded shutdown (ignore SIGTERM='+ignoreTerm+', suppress close='+suppressClose+')',async(t)=>{
 if(process.platform==='win32'){t.skip('The image verifier uses POSIX process groups');return;}
 const root=await mkdtemp(join(tmpdir(),'pi-qualification-cleanup-test-'));
 try{
  const pack=join(root,'pack'),modules=join(pack,'dist/drivers/acpx');await mkdir(modules,{recursive:true});
  await writeFile(join(pack,'package.json'),JSON.stringify({type:'module'}));
  await writeFile(join(modules,'qualified-profiles.js'),'export const resolveQualifiedAcpxProfile=()=>({});');
  await writeFile(join(modules,'installation-integrity.js'),`
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
export const createAcpxPackageJsonResolver=()=>({});
export async function verifyQualifiedAcpxInstallation(){return {openCommand:async()=>{
 let child,closed=false;
 return {spawn:(_args,options)=>{
   child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(join(root,'provider.mjs'))}],{...options,stdio:['pipe','pipe','pipe']});
   child.once('close',()=>{closed=true;});
   if (${suppressClose}) {
     const once=child.once.bind(child);
     child.once=(event,listener)=>event==='close'?child:once(event,listener);
   }
   return child;
 },close:async()=>{assert(closed,'lease was closed before the provider completed its shutdown writes');await writeFile(${JSON.stringify(join(root,'lease-closed'))},String(child.signalCode??child.exitCode));}};
}};}
`);
  await writeFile(join(root,'provider.mjs'),`
import fs from 'node:fs';import readline from 'node:readline';import path from 'node:path';
fs.writeFileSync(${JSON.stringify(join(root,'home-path'))},process.env.HOME);
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.method==='initialize'?{}:{sessionId:'fixture-session'}})+'\\n');});
process.on('SIGTERM',()=>{if(${ignoreTerm})return;setTimeout(()=>{fs.mkdirSync(path.join(process.env.HOME,'.pi'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.pi','last-write'),'shutdown completed');fs.writeFileSync(${JSON.stringify(join(root,'shutdown-finished'))},'finished');process.exit(0);},150);});
`);
  const child=spawn(process.execPath,[verifier,pack],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  let code;try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);}
  if(suppressClose){assert.notEqual(code,0);assert.match(stderr,/Pi qualification process did not close after SIGKILL/);}
  else assert.equal(code,0,stderr);
  assert.match(stdout,/Verified Pi ACP/);
  if(!ignoreTerm)assert.equal(await readFile(join(root,'shutdown-finished'),'utf8'),'finished');
  assert.equal(await readFile(join(root,'lease-closed'),'utf8'),ignoreTerm?'SIGKILL':'0');
  const home=await readFile(join(root,'home-path'),'utf8');await assert.rejects(readFile(join(home,'.pi','last-write')), {code:'ENOENT'});
 }finally{
  const home=await readFile(join(root,'home-path'),'utf8').catch(()=>null);
  if(home){assert.equal(dirname(home),tmpdir());assert(basename(home).startsWith('pi-qualified-launch-'));await rm(home,{recursive:true,force:true});}
  await rm(root,{recursive:true,force:true});
 }
});
