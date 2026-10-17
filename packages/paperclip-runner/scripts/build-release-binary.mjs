import {execFileSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyReleaseArtifact} from '../../../scripts/verified-runner-release.mjs';
import {stageRunnerBinary} from './stage-runner-binary.mjs';

const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const RELEASE_BUILD_ARGS=['build','--release','--manifest-path','runner/Cargo.toml','--locked','-p','paperclip-runner-core','--bin','paperclip-runnerd'];

export async function buildReleaseBinary({root=resolve(packageRoot,'../..'),env=process.env,
  compile=(command,args,options)=>execFileSync(command,args,options),stage=stageRunnerBinary}={}) {
  const pkg=join(root,'packages/paperclip-runner');
  const executable=process.platform==='win32'?'paperclip-runnerd.exe':'paperclip-runnerd';
  const receiptPath=env.PAPERCLIP_RUNNER_RELEASE_CACHE_RECEIPT;
  let source;
  if(receiptPath) source=verifyReleaseArtifact({root,receiptPath,env});
  else {
    compile('cargo',RELEASE_BUILD_ARGS,{cwd:pkg,env,stdio:'inherit'});
    source=join(pkg,'runner/target/release',executable);
  }
  await stage(source,join(pkg,'dist/bin',executable));
  return {reused:Boolean(receiptPath)};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildReleaseBinary()));
}
