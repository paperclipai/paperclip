import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {computeScope, HASHED_INPUTS, RUNNER_PACKAGE} from './runner-release-crate-cache.mjs';
import {collectBuildWitness, validateEnvironmentWitness} from './runner-release-build-witness.mjs';

const schema = 'paperclip.verified-runner-release.v1';
export const RELEASE_ARTIFACT_INPUTS = HASHED_INPUTS;
export const RELEASE_PRODUCER_RECEIPT = `${RUNNER_PACKAGE}/runner/target/release/verified-artifact.json`;

export function sourceDigest(root) {
  const hash = createHash('sha256');
  let files = 0;
  const visit = file => {
    assert.equal(realpathSync(file), file, 'Release input paths must be canonical');
    const info = lstatSync(file);
    assert.ok(!info.isSymbolicLink(), 'Release inputs must not be symlinks');
    if (info.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(join(file, name));
    } else {
      assert.ok(info.isFile() && info.size <= 64 * 1024 * 1024 && ++files <= 100_000, 'Unbounded release input');
      hash.update(JSON.stringify([relative(root, file), info.size]));
      hash.update(readFileSync(file));
    }
  };
  for (const pattern of RELEASE_ARTIFACT_INPUTS) {
    const target = join(root, pattern.replace(/\/\*\*$/, ''));
    hash.update(JSON.stringify([pattern, existsSync(target)]));
    if (existsSync(target)) visit(target);
  }
  return hash.digest('hex');
}

export function releaseEnvironmentReason(env = process.env, root) {
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if ((key === 'CARGO_INCREMENTAL' && value !== '0') || /^(?:RUSTFLAGS|RUSTC(?:_|$)|RUSTDOC(?:_|$)|CARGO_ENCODED_RUST|CARGO_BUILD_(?:TARGET|RUST)|CARGO_TARGET_|CARGO_PROFILE_|(?:HOST_|TARGET_)?(?:CC|CXX|CFLAGS|CXXFLAGS|LDFLAGS|AR)(?:_|$)|SDKROOT$|MACOSX_DEPLOYMENT_TARGET$)/.test(key)
      && !(key === 'CARGO_PROFILE_DEV_DEBUG' && value === '0')) return `Custom build environment: ${key}`;
  }
  const cargo = env.CARGO_HOME || join(env.HOME || homedir(), '.cargo');
  for (const file of ['config', 'config.toml']) {
    if (existsSync(join(cargo, file))) return 'Cargo home configuration requires a normal build';
  }
  if (root) {
    let directory = join(root, RUNNER_PACKAGE, 'runner');
    while (true) {
      for (const name of ['config', 'config.toml']) {
        if (existsSync(join(directory, '.cargo', name))) return 'Ancestor Cargo configuration requires a normal build';
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return null;
}

function regular(file, maximum) {
  assert.equal(realpathSync(file), resolve(file), 'Release receipt files must be canonical');
  const info = lstatSync(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, 'Invalid release receipt file');
  return info;
}

export function recordReleaseArtifact({root, env = process.env, rustcVersion, compilerMetadata}) {
  root = realpathSync(root);
  const output = join(root, RELEASE_PRODUCER_RECEIPT);
  rmSync(output, {force:true});
  try {
    const reason = releaseEnvironmentReason(env, root);
    assert.equal(reason, null, reason ?? 'Unsupported build environment');
    const binary = join(dirname(output), process.platform === 'win32' ? 'paperclip-runnerd.exe' : 'paperclip-runnerd');
    regular(binary, 256 * 1024 * 1024);
    const witness = collectBuildWitness({root, env, compilerMetadata});
    const receipt = {schema, root, scope:computeScope({workspace:root,env,rustcVersion}), sourceDigest:sourceDigest(root),
      binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex'), ...witness};
    writeFileSync(output, JSON.stringify(receipt), {mode:0o600});
    return {recorded:true, depInfoFiles:witness.depInfoFiles};
  } catch (error) { return {recorded:false, reason:error.message}; }
}

export function prepareReleaseArtifact({root, temporaryDirectory, matchedKey, expectedKey, env = process.env, rustcVersion}) {
  root = realpathSync(root);
  if (!expectedKey?.startsWith('runner-release-crate-v2-') || matchedKey !== expectedKey) return {ready:false, reason:'No exact artifact cache match'};
  const reason = releaseEnvironmentReason(env, root);
  if (reason) return {ready:false, reason};
  const source = join(root, RUNNER_PACKAGE, 'runner/target/release', process.platform === 'win32' ? 'paperclip-runnerd.exe' : 'paperclip-runnerd');
  if (!existsSync(source)) return {ready:false, reason:'Missing cached release executable'};
  const info = regular(source, 256 * 1024 * 1024);
  if (!(info.mode & 0o111)) return {ready:false, reason:'Cached release artifact is not executable'};
  const scope = computeScope({workspace:root,env,rustcVersion});
  if (scope.includes('no-rustc')) return {ready:false, reason:'Compiler identity unavailable'};
  const producerFile = join(root, RELEASE_PRODUCER_RECEIPT);
  if (!existsSync(producerFile)) return {ready:false, reason:'Missing producer build witness'};
  regular(producerFile, 64 * 1024);
  const producer = JSON.parse(readFileSync(producerFile,'utf8'));
  assert.equal(producer.schema,schema,'Unknown producer witness');
  assert.equal(producer.root,root,'Producer checkout mismatch');
  assert.equal(producer.scope,scope,'Producer compiler mismatch');
  assert.equal(producer.sourceDigest,sourceDigest(root),'Producer source inputs mismatch');
  assert.equal(producer.binarySha256,createHash('sha256').update(readFileSync(source)).digest('hex'),'Producer release bytes mismatch');
  validateEnvironmentWitness(producer.environment,env);
  mkdirSync(temporaryDirectory, {recursive:true});
  const snapshot = realpathSync(mkdtempSync(join(temporaryDirectory, 'verified-runner-')));
  const binary = join(snapshot, 'paperclip-runnerd');
  try {
    const digest = sourceDigest(root);
    copyFileSync(source, binary);
    const receipt = {...producer, sourceDigest:digest};
    assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'),producer.binarySha256,'Release snapshot changed during copying');
    const receiptPath = join(snapshot, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt), {mode:0o600});
    return {ready:true, receiptPath, binaryBytes:statSync(binary).size};
  } catch (error) {
    rmSync(snapshot, {recursive:true, force:true});
    throw error;
  }
}

export function verifyReleaseArtifact({root, receiptPath, env = process.env, rustcVersion}) {
  root = realpathSync(root);
  assert.equal(releaseEnvironmentReason(env, root), null, 'Release build environment changed');
  regular(receiptPath, 64 * 1024);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.schema, schema, 'Unknown release receipt');
  assert.equal(receipt.root, root, 'Release receipt belongs to a different checkout');
  assert.equal(receipt.scope, computeScope({workspace:root,env,rustcVersion}), 'Release compiler identity changed');
  assert.equal(receipt.sourceDigest, sourceDigest(root), 'Release inputs changed after cache validation');
  validateEnvironmentWitness(receipt.environment,env);
  const binary = join(dirname(receiptPath), 'paperclip-runnerd');
  const info = regular(binary, 256 * 1024 * 1024);
  assert.ok(info.mode & 0o111, 'Verified release artifact is not executable');
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), receipt.binarySha256, 'Verified release bytes changed');
  return binary;
}
