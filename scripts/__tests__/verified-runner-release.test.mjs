import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {prepareReleaseArtifact, recordReleaseArtifact, releaseEnvironmentReason, sourceDigest, verifyReleaseArtifact} from '../verified-runner-release.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'verified-release-')));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const put = (path, value) => {const file = join(root,path); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,value); return file;};
  const input = put('packages/paperclip-runner/runner/crates/runner-core/src/main.rs', 'fn main() {}');
  put('packages/paperclip-runner/runner/Cargo.toml', '[workspace]');
  put('packages/paperclip-runner/runner/Cargo.lock', 'version = 4');
  const binary = put('packages/paperclip-runner/runner/target/release/paperclip-runnerd', '#!/bin/sh\nexit 0\n');
  chmodSync(binary,0o755);
  const binSource=put('packages/paperclip-runner/runner/crates/runner-core/src/bin/paperclip-runnerd.rs','fn main() {}');
  const manifest=put('packages/paperclip-runner/runner/crates/runner-core/Cargo.toml','[package]\nname = \"paperclip-runner-core\"\nversion = \"0.0.0\"');
  put('packages/paperclip-runner/runner/target/release/deps/paperclip_runner_core-unit.d', `target: ${input}\n`);
  put('packages/paperclip-runner/runner/target/release/deps/paperclip_runnerd-unit.d', `target: ${binSource}\n# env-dep:CARGO_PKG_VERSION=0.0.0\n`);
  const env = {HOME:join(root,'home'),CARGO_PROFILE_DEV_DEBUG:'0'};
  const options = {root,temporaryDirectory:join(root,'private'),env,rustcVersion:'1.97.1-qualified-host',
    expectedKey:'runner-release-crate-v2-exact',matchedKey:'runner-release-crate-v2-exact',
    compilerMetadata:{workspace_root:join(root,'packages/paperclip-runner/runner'),packages:[{manifest_path:manifest,version:'0.0.0',dependencies:[],
      targets:[{name:'paperclip_runner_core',kind:['lib'],src_path:input},{name:'paperclip-runnerd',kind:['bin'],src_path:binSource}]}]}};
  assert.equal(recordReleaseArtifact(options).recorded,true);
  return {root,put,input,binary,options};
}

test('an exact cache match creates an independent verified executable snapshot', t => {
  const f=fixture(t), receipt=prepareReleaseArtifact(f.options);
  assert.equal(receipt.ready,true);
  const copy=verifyReleaseArtifact({...f.options,receiptPath:receipt.receiptPath});
  assert.equal(readFileSync(copy,'utf8'),readFileSync(f.binary,'utf8'));
  writeFileSync(f.binary,'the original Cargo target is no longer required');
  assert.equal(verifyReleaseArtifact({...f.options,receiptPath:receipt.receiptPath}),copy);
});

test('a miss, prefix match, old schema or missing executable never permits reuse', t => {
  const f=fixture(t);
  for(const matchedKey of ['', 'runner-release-crate-v2-', 'runner-release-crate-v1-exact']) {
    assert.equal(prepareReleaseArtifact({...f.options,matchedKey}).ready,false);
  }
  assert.equal(prepareReleaseArtifact({...f.options,expectedKey:'runner-release-crate-v1-exact',matchedKey:'runner-release-crate-v1-exact'}).ready,false);
  chmodSync(f.binary,0o644);
  assert.equal(prepareReleaseArtifact(f.options).ready,false);
  rmSync(f.binary);
  assert.equal(prepareReleaseArtifact(f.options).ready,false);
});

test('changed source, new configuration and changed compiler identities fail closed', t => {
  const f=fixture(t), receipt=prepareReleaseArtifact(f.options);
  const options={...f.options,receiptPath:receipt.receiptPath};
  writeFileSync(f.input,'fn main() { panic!("changed"); }');
  assert.throws(()=>verifyReleaseArtifact(options),/inputs changed/);
  writeFileSync(f.input,'fn main() {}');
  assert.throws(()=>verifyReleaseArtifact({...options,rustcVersion:'different-compiler'}),/compiler identity changed/);
  f.put('.cargo/config.toml','[build]\ntarget = "different"');
  assert.throws(()=>verifyReleaseArtifact(options),/environment changed/);
  assert.equal(prepareReleaseArtifact(f.options).ready,false);
});

test('corrupted snapshots, symlinks and checkout substitution cannot qualify', t => {
  const f=fixture(t), receipt=prepareReleaseArtifact(f.options);
  const options={...f.options,receiptPath:receipt.receiptPath};
  const copy=verifyReleaseArtifact(options);
  writeFileSync(copy,'corrupted');
  assert.throws(()=>verifyReleaseArtifact(options),/bytes changed/);
  rmSync(copy);symlinkSync(f.binary,copy);
  assert.throws(()=>verifyReleaseArtifact(options),/canonical|Invalid release/);
  const other=f.put('other/marker','x');
  assert.throws(()=>verifyReleaseArtifact({...options,root:dirname(other)}),/different checkout/);
});

test('custom compiler inputs and Cargo home configuration require a normal build', t => {
  const f=fixture(t);
  for(const key of ['RUSTFLAGS','RUSTC','RUSTC_WRAPPER','CARGO_BUILD_TARGET','CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER','CARGO_ENCODED_RUSTFLAGS','CARGO_PROFILE_RELEASE_LTO','CC','CFLAGS','TARGET_CC','CC_aarch64_unknown_linux_gnu','SDKROOT','CARGO_INCREMENTAL']) {
    assert.ok(releaseEnvironmentReason({...f.options.env,[key]:'custom'}),key);
    assert.equal(prepareReleaseArtifact({...f.options,env:{...f.options.env,[key]:'custom'}}).ready,false,key);
  }
  const receipt=prepareReleaseArtifact(f.options);
  assert.throws(()=>verifyReleaseArtifact({...f.options,receiptPath:receipt.receiptPath,env:{...f.options.env,RUSTFLAGS:'changed'}}),/environment changed/);
  f.put('home/.cargo/config.toml','[build]');
  assert.match(releaseEnvironmentReason(f.options.env),/Cargo home/);
});

test('source fingerprinting detects new files and rejects links outside the checkout', t => {
  const f=fixture(t), original=sourceDigest(f.root);
  const additional=f.put('packages/paperclip-runner/protocol/new-schema.json','{}');
  assert.notEqual(sourceDigest(f.root),original);
  rmSync(additional);
  rmSync(dirname(additional), {recursive:true});
  assert.equal(sourceDigest(f.root),original);
  mkdirSync(dirname(additional));
  symlinkSync('/etc/hosts',additional);
  assert.throws(()=>sourceDigest(f.root),/canonical|symlink/);
});

test('producer evidence rejects undeclared inputs, custom build scripts and stale binaries', t => {
  const f=fixture(t);
  const changed=structuredClone(f.options.compilerMetadata);
  changed.packages[0].targets.push({name:'build-script-build',kind:['custom-build'],src_path:f.input});
  assert.equal(recordReleaseArtifact({...f.options,compilerMetadata:changed}).recorded,false);
  assert.equal(prepareReleaseArtifact(f.options).ready,false);
  const outside=f.put('outside/src.rs','fn main() {}');
  f.put('packages/paperclip-runner/runner/target/release/deps/paperclip_runner_core-unit.d',`target: ${outside}\n`);
  assert.equal(recordReleaseArtifact(f.options).recorded,false);
});

test('actual compiler environment dependencies remain bound to their producer values', t => {
  const f=fixture(t);
  f.put('packages/paperclip-runner/runner/target/release/deps/paperclip_runner_core-unit.d',`target: ${f.input}\n# env-dep:QUALIFIED_BUILD_MODE=qualified\n`);
  const options={...f.options,env:{...f.options.env,QUALIFIED_BUILD_MODE:'qualified'}};
  assert.equal(recordReleaseArtifact(options).recorded,true);
  const receipt=prepareReleaseArtifact(options);
  assert.equal(receipt.ready,true);
  assert.throws(()=>verifyReleaseArtifact({...options,receiptPath:receipt.receiptPath,env:{...options.env,QUALIFIED_BUILD_MODE:'different'}}),/environment changed/);
  assert.equal(readFileSync(receipt.receiptPath,'utf8').includes('"qualified"'),false,'Producer environment values are hashed');
});

test('normal release builds retain the complete original Cargo command and staging', async () => {
  const {buildReleaseBinary,RELEASE_BUILD_ARGS}=await import('../../packages/paperclip-runner/scripts/build-release-binary.mjs');
  const calls=[];
  const result=await buildReleaseBinary({root:'/fixture',env:{},
    compile:(...args)=>calls.push(['compile',...args]),stage:async(...args)=>calls.push(['stage',...args])});
  assert.deepEqual(result,{reused:false});
  assert.deepEqual(calls[0],['compile','cargo',RELEASE_BUILD_ARGS,{cwd:'/fixture/packages/paperclip-runner',env:{},stdio:'inherit'}]);
  const executable=process.platform==='win32'?'paperclip-runnerd.exe':'paperclip-runnerd';
  assert.deepEqual(calls[1],['stage',`/fixture/packages/paperclip-runner/runner/target/release/${executable}`,`/fixture/packages/paperclip-runner/dist/bin/${executable}`]);
});


test('ancestor Cargo configuration and declared dependency build inputs cannot bypass reuse checks', t => {
  const f=fixture(t);
  const receipt=prepareReleaseArtifact(f.options);
  f.put('packages/.cargo/config.toml','[build]');
  assert.equal(prepareReleaseArtifact(f.options).ready,false);
  assert.throws(()=>verifyReleaseArtifact({...f.options,receiptPath:receipt.receiptPath}),/environment changed/);
  rmSync(join(f.root,'packages/.cargo'),{recursive:true});
  f.put('packages/paperclip-runner/runner/target/release/build/dependency/output','cargo:rerun-if-env-changed=TARGET_BUILD_MODE\n');
  const options={...f.options,env:{...f.options.env,TARGET_BUILD_MODE:'qualified'}};
  assert.equal(recordReleaseArtifact(options).recorded,true);
  const prepared=prepareReleaseArtifact(options);
  assert.equal(prepared.ready,true);
  assert.throws(()=>verifyReleaseArtifact({...options,receiptPath:prepared.receiptPath,env:f.options.env}),/environment changed/);
});

test('CLI verification failure discards only the restored workspace crate and retains normal-build fallback', t => {
  const f=fixture(t);
  f.put('packages/paperclip-runner/runner/target/release/deps/libserde-thirdparty.rlib','keep');
  const output=f.put('job-output','');
  const environment=f.put('job-env','');
  const result=spawnSync(process.execPath,[new URL('../runner-release-crate-cache.mjs',import.meta.url).pathname,'prepare-artifact'],{
    env:{...process.env,GITHUB_WORKSPACE:f.root,GITHUB_OUTPUT:output,GITHUB_ENV:environment,RUNNER_TEMP:join(f.root,'private'),
      RUNNER_ARTIFACT_EXPECTED_KEY:'runner-release-crate-v2-current',RUNNER_ARTIFACT_MATCHED_KEY:'runner-release-crate-v2-different'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).ready,false);
  assert.equal(readFileSync(output,'utf8'),'ready=false\n');
  assert.equal(readFileSync(environment,'utf8'),'');
  assert.equal(readFileSync(join(f.root,'packages/paperclip-runner/runner/target/release/deps/libserde-thirdparty.rlib'),'utf8'),'keep');
  assert.throws(()=>readFileSync(f.binary),{code:'ENOENT'});
});
