import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const enabled = process.platform === 'linux';
let root;
let script;
let environment;
before(async () => {
  if (!enabled) return;
  root = await mkdtemp(path.join(tmpdir(), 'paperclip-wsl-helper-'));
  const repo = path.join(root, 'repo');
  const instance = path.join(root, 'data', 'instances', 'default');
  script = path.join(repo, 'skills', 'paperclip-wsl', 'scripts', 'paperclip-wsl.mjs');
  await mkdir(path.dirname(script), { recursive: true });
  await mkdir(path.join(repo, '.paperclip'), { recursive: true });
  await mkdir(instance, { recursive: true });
  await mkdir(path.join(repo,'packages/shared/src'),{recursive:true});
  await writeFile(path.join(repo,'packages/shared/src/agent-runner.ts'),'export const paperclipRunnerSupportsPlatform=()=>true; export const PAPERCLIP_RUNNER_MINIMUM_GLIBC_VERSION="2.39";');
  await copyFile(fileURLToPath(new URL('./paperclip-wsl.mjs', import.meta.url)), script);
  const bins = [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'];
  const home = path.join(root, 'data');
  await writeFile(path.join(repo, '.paperclip', 'wsl.local.json'), JSON.stringify({
    distro: process.env.WSL_DISTRO_NAME || 'test', user: (await import('node:os')).userInfo().username,
    checkout: repo, node: process.execPath, paperclipHome: home, instanceId: 'default', port: 3100,
    binPaths: bins, ...(process.env.WSL_DISTRO_NAME ? { capacityPath: "/mnt/c" } : {}), minimumFreeBytes: 1,
  }));
  await writeFile(path.join(instance, 'config.json'), JSON.stringify({ server: { port: 3100 } }));
  environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('PAPERCLIP_') || ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'PORT'].includes(key)) delete environment[key];
  }
  assert.equal(spawnSync('git', ['init', repo], { env: environment, encoding: 'utf8' }).status, 0);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
function invoke(args, extra = {}) {
  return spawnSync(process.execPath, [script, ...args], { env: { ...environment, ...extra }, encoding: 'utf8', timeout: 10000 });
}
test('passes spaces and Unicode as one argument and selects the configured instance', { skip: !enabled }, () => {
  const result = invoke(['exec', process.execPath, '-e', 'console.log(JSON.stringify({args:process.argv.slice(1),config:process.env.PAPERCLIP_CONFIG}))', 'ruimte en café']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.args, ['ruimte en café']);
  assert.equal(output.config, path.join(root, 'data', 'instances', 'default', 'config.json'));
});
for (const [key, value] of [['PAPERCLIP_INSTANCE_ID', 'other'], ['PAPERCLIP_CONFIG', '/tmp/other.json'], ['DATABASE_URL', 'postgres://other'], ['DATABASE_MIGRATION_URL', 'postgres://other'], ['PORT', '3101']]) {
  test('refuses ' + key + ' before starting the requested command', { skip: !enabled }, () => {
    const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")'], { [key]: value });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(key));
    assert.doesNotMatch(result.stdout, /STARTED/);
  });
}
test('refuses Windows executables and reports missing native tools', { skip: !enabled }, () => {
  const result = invoke(['exec', 'definitely-unavailable-paperclip.exe']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-native or unavailable command/);
});

for (const location of ['instance', 'checkout']) {
  test('rejects saved database overrides in the ' + location + ' dotenv file', { skip: !enabled }, async () => {
    const file = location === 'instance' ? path.join(root, 'data', 'instances', 'default', '.env') : path.join(root, 'repo', '.env');
    await writeFile(file, 'DATABASE_URL=postgres://another-database\n');
    try {
      const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /DATABASE_URL/);
      assert.doesNotMatch(result.stdout, /STARTED/);
    } finally { await rm(file); }
  });
}
test('rejects a different Windows instance selection before executing', { skip: !enabled }, async () => {
  const config = JSON.parse(await readFile(path.join(root, 'repo', '.paperclip', 'wsl.local.json'), 'utf8'));
  config.instanceId = 'another-instance';
  const result = invoke(['--linux-entry', Buffer.from(JSON.stringify(config)).toString('base64url'), 'exec', process.execPath, '-e', 'console.log("STARTED")']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Windows and Linux profiles differ/);
  assert.doesNotMatch(result.stdout, /STARTED/);
});
test('puts the selected Node before a conflicting configured PATH', { skip: !enabled }, async () => {
  const file = path.join(root, 'repo', '.paperclip', 'wsl.local.json');
  const saved = await readFile(file, 'utf8');
  const config = JSON.parse(saved);
  const bin = path.join(root, 'shadow-bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'node'), '#!/bin/sh\necho WRONG_NODE\n');
  await chmod(path.join(bin, 'node'), 0o755);
  config.binPaths.unshift(bin);
  await writeFile(file, JSON.stringify(config));
  try {
    const result = invoke(['exec', 'node', '-e', 'console.log(process.execPath)']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), process.execPath);
  } finally { await writeFile(file, saved); }
});
test('rejects a Windows backup path in the selected instance config', { skip: !enabled }, async () => {
  const file = path.join(root, 'data', 'instances', 'default', 'config.json');
  const saved = await readFile(file, 'utf8');
  await writeFile(file, JSON.stringify({server:{port:3100},database:{embeddedPostgresDataDir:path.join(root,"data","instances","default","db"),backup:{dir:'C:\\old-backups'}}}));
  try {
    const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Windows data paths/);
  } finally { await writeFile(file, saved); }
});
test('requires host capacity selection when invoked in WSL', { skip: !enabled }, async () => {
  const file = path.join(root, 'repo', '.paperclip', 'wsl.local.json');
  const saved = await readFile(file, 'utf8');
  const config = JSON.parse(saved);
  delete config.capacityPath;
  await writeFile(file, JSON.stringify(config));
  try {
    const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")'], { WSL_DISTRO_NAME: config.distro });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /capacityPath/);
  } finally { await writeFile(file, saved); }
});

for (const backup of ['~/backups', './backups']) {
  test('accepts supported native backup path ' + backup, { skip: !enabled }, async () => {
    const file = path.join(root, 'data', 'instances', 'default', 'config.json');
    const saved = await readFile(file, 'utf8');
    await writeFile(file, JSON.stringify({server:{port:3100},database:{embeddedPostgresDataDir:path.join(root,"data","instances","default","db"),backup:{dir:backup}}}));
    try {
      const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /STARTED/);
    } finally { await writeFile(file, saved); }
  });
}

for (const [key, value] of [['PAPERCLIP_CONTEXT','/tmp/other/context.json'], ['PAPERCLIP_AUTH_STORE','/tmp/other/auth.json'], ['PAPERCLIP_STORAGE_PROVIDER','s3'], ['PAPERCLIP_STORAGE_S3_BUCKET','other'], ['PAPERCLIP_STORAGE_S3_ENDPOINT','https://other.invalid'], ['PAPERCLIP_STORAGE_S3_PREFIX','other/'], ['PAPERCLIP_IN_WORKTREE','true'], ['PAPERCLIP_API_URL','http://localhost:3101']]) {
  test('rejects inherited instance selector ' + key, { skip: !enabled }, () => {
    const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")'], { [key]: value });
    assert.equal(result.status, 1);
    assert.match(result.stderr, key === "PAPERCLIP_API_URL" ? /CLI context targets another instance/ : new RegExp(key));
    assert.doesNotMatch(result.stdout, /STARTED/);
  });
}
test('rejects a normalized data path into a Windows mount', { skip: !enabled }, async () => {
  const file = path.join(root, 'data', 'instances', 'default', 'config.json');
  const saved = await readFile(file, 'utf8');
  await writeFile(file, JSON.stringify({server:{port:3100},storage:{localDisk:{baseDir:'/home/../mnt/c/other'}}}));
  try {
    const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Windows data paths/);
  } finally { await writeFile(file, saved); }
});

for (const location of ['home', 'checkout']) {
  test('rejects a saved CLI API target in the ' + location + ' context', { skip: !enabled }, async () => {
    const file = location === 'home' ? path.join(root, 'data', 'context.json') : path.join(root, 'repo', '.paperclip', 'context.json');
    await writeFile(file, JSON.stringify({version:2,currentProfile:'default',profiles:{default:{apiBase:'https://another-instance.invalid'}}}));
    try {
      const result = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /CLI context targets another instance/);
      assert.doesNotMatch(result.stdout, /STARTED/);
    } finally { await rm(file); }
  });
}
test('preserves the checkout CLI context for the selected local instance', { skip: !enabled }, async () => {
  const file = path.join(root, 'repo', '.paperclip', 'context.json');
  await writeFile(file, JSON.stringify({version:2,currentProfile:'default',profiles:{default:{apiBase:'http://localhost:3100',companyId:'local-company'}}}));
  try {
    const result = invoke(['exec', process.execPath, '-e', 'console.log(process.env.PAPERCLIP_CONTEXT)']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), file);
  } finally { await rm(file); }
});

test('allows unused remote profiles while rejecting an explicitly selected remote profile', { skip: !enabled }, async () => {
  const file = path.join(root, 'data', 'context.json');
  await writeFile(file, JSON.stringify({version:2,currentProfile:'local',profiles:{local:{apiBase:'http://localhost:3100'},remote:{apiBase:'https://remote.invalid'}}}));
  try {
    const local = invoke(['exec', process.execPath, '-e', 'console.log("STARTED")']);
    assert.equal(local.status, 0, local.stderr);
    const remote = invoke(['exec', 'pnpm', 'paperclipai', '--profile', 'remote', 'company', 'list']);
    assert.equal(remote.status, 1);
    assert.match(remote.stderr, /CLI context targets another instance/);
  } finally { await rm(file); }
});

test('uses the final repeated CLI profile selector', { skip: !enabled }, async () => {
  const file = path.join(root, 'data', 'context.json');
  await writeFile(file, JSON.stringify({version:2,currentProfile:'local',profiles:{local:{apiBase:'http://localhost:3100'},remote:{apiBase:'https://remote.invalid'}}}));
  try {
    const result = invoke(['exec', 'pnpm', 'paperclipai', '--profile', 'local', '--profile=remote', 'company', 'list']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLI context targets another instance/);
  } finally { await rm(file); }
});
test('passes literal option names to non-Paperclip commands', { skip: !enabled }, () => {
  const result = invoke(['exec', process.execPath, '-e', 'console.log(process.argv.slice(1).join(" "))', '--', '--api-base', 'literal-text']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--api-base literal-text/);
});

for (const args of [ ['npm','run','paperclipai','--','company','list','--api-base','http://localhost:3101'], [process.execPath,'cli/node_modules/tsx/dist/cli.mjs','cli/src/index.ts','company','list','--api-base=http://localhost:3101'], ['pnpm','paperclipai','db:backup','--config','/tmp/other.json'], ['pnpm','paperclipai','db:backup','-c/tmp/other.json'], ['pnpm','paperclipai','db:backup','--data-dir','/tmp/other'] ]) {
  test('rejects a forwarded or explicit CLI destination: ' + args.join(' '), { skip: !enabled }, () => {
    const result=invoke(['exec',...args]);
    assert.equal(result.status,1);
    assert.match(result.stderr,/another instance|selected instance/);
  });
}
for (const marker of ['1','yes','on','TRUE']) test('rejects truthy scheduling marker '+marker,{skip:!enabled},()=>{
  const result=invoke(['exec',process.execPath,'-e','console.log("STARTED")'],{PAPERCLIP_IN_WORKTREE:marker});
  assert.equal(result.status,1);assert.match(result.stderr,/PAPERCLIP_IN_WORKTREE/);
});
test('accepts the default server port when omitted by the config', {skip:!enabled},async()=>{
  const file=path.join(root,'data','instances','default','config.json');const saved=await readFile(file,'utf8');await writeFile(file,JSON.stringify({server:{}}));
  try{const result=invoke(['exec',process.execPath,'-e','console.log("STARTED")']);assert.equal(result.status,0,result.stderr);}finally{await writeFile(file,saved);}
});
test('rejects a conflicting inherited secrets key without exposing either value',{skip:!enabled},async()=>{
  const file=path.join(root,'data','instances','default','.env');await writeFile(file,'PAPERCLIP_SECRETS_MASTER_KEY=selected-test-key\n');
  try{const result=invoke(['exec',process.execPath,'-e','console.log("STARTED")'],{PAPERCLIP_SECRETS_MASTER_KEY:'wrong-test-key'});assert.equal(result.status,1);assert.match(result.stderr,/PAPERCLIP_SECRETS_MASTER_KEY/);assert.doesNotMatch(result.stderr,/selected-test-key|wrong-test-key/);}finally{await rm(file);}
});

for(const key of ['PAPERCLIP_AGENT_JWT_SECRET','BETTER_AUTH_SECRET','PAPERCLIP_TOOL_ACTION_SIGNING_SECRET','PAPERCLIP_SECRETS_AWS_REGION','PAPERCLIP_SECRETS_AWS_PREFIX']) test('rejects another instance identity: '+key,{skip:!enabled},()=>{const result=invoke(['exec',process.execPath,'-e','console.log("STARTED")'],{[key]:'other-instance-value'});assert.equal(result.status,1);assert.match(result.stderr,new RegExp(key));assert.doesNotMatch(result.stderr,/other-instance-value/);});
for(const args of [['company','import','--paperclip-url','https://other.invalid'],['service','stop','--instance','other'],['service','uninstall','-iother']]) test('rejects CLI alias '+args.join(' '),{skip:!enabled},()=>{const result=invoke(['exec','pnpm','paperclipai',...args]);assert.equal(result.status,1);assert.match(result.stderr,/another instance/);});
test('rejects a Windows Runner binary override',{skip:!enabled},()=>{const result=invoke(['exec',process.execPath,'-e','console.log("STARTED")'],{PAPERCLIP_RUNNER_BINARY:'/mnt/c/runner.exe'});assert.equal(result.status,1);assert.match(result.stderr,/PAPERCLIP_RUNNER_BINARY/);});
test('rejects capacity escaping the selected host mount',{skip:!enabled||!process.env.WSL_DISTRO_NAME},async()=>{const file=path.join(root,'repo','.paperclip','wsl.local.json');const saved=await readFile(file,'utf8');await writeFile(file,JSON.stringify({...JSON.parse(saved),capacityPath:'/mnt/c/..'}));try{const result=invoke(['exec',process.execPath,'-e','console.log("STARTED")']);assert.equal(result.status,1);assert.match(result.stderr,/capacityPath resolves outside/);}finally{await writeFile(file,saved);}});
for(const selected of [false,true]) test('verifies the actual health listener identity ('+selected+')',{skip:!enabled},async()=>{
 const profileFile=path.join(root,'repo','.paperclip','wsl.local.json'),configFile=path.join(root,'data','instances','default','config.json');
 const savedProfile=await readFile(profileFile,'utf8'),savedConfig=await readFile(configFile,'utf8');
 const child=spawn(process.execPath,['-e','const server=require("node:http").createServer((req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({status:"ok"}));});server.listen(0,"127.0.0.1",()=>console.log(server.address().port));'],{env:{...environment,PAPERCLIP_HOME:selected?path.join(root,'data'):'/tmp/other-instance',PAPERCLIP_INSTANCE_ID:'default',PAPERCLIP_CONFIG:configFile},stdio:['ignore','pipe','pipe']});
 try{const port=await new Promise((resolve,reject)=>{child.stdout.once('data',data=>resolve(Number(String(data).trim())));child.once('error',reject);child.once('exit',()=>reject(Error('listener exited before readiness')));});await writeFile(profileFile,JSON.stringify({...JSON.parse(savedProfile),port}));await writeFile(configFile,JSON.stringify({server:{port}}));const result=invoke(['preflight','--health']);assert.equal(result.status,selected?0:1,result.stderr);if(!selected)assert.match(result.stderr,/health listener does not belong/);
 }finally{child.kill();await writeFile(profileFile,savedProfile);await writeFile(configFile,savedConfig);}
});

for(const [key,value] of [['PAPERCLIP_SERVER_HOST','other.invalid'],['PAPERCLIP_SERVER_PORT','3101'],['RUN_LOG_BASE_PATH','/mnt/c/other'],['RUN_LOG_S3_BUCKET','other']]) test('rejects inherited destination '+key,{skip:!enabled},()=>{const result=invoke(['exec',process.execPath,'-e','console.log("STARTED")'],{[key]:value});assert.equal(result.status,1);assert.match(result.stderr,new RegExp(key));});
for(const section of ['database','storage','secrets']) test('rejects ambiguous schema defaults for '+section,{skip:!enabled},async()=>{const file=path.join(root,'data','instances','default','config.json'),saved=await readFile(file,'utf8');await writeFile(file,JSON.stringify({server:{port:3100},[section]:{}}));try{const result=invoke(['exec',process.execPath,'-e','console.log("STARTED")']);assert.equal(result.status,1);assert.match(result.stderr,/explicit data path/);}finally{await writeFile(file,saved);}});
test('accepts explicit home-relative data paths',{skip:!enabled},async()=>{const file=path.join(root,'data','instances','default','config.json'),saved=await readFile(file,'utf8');await writeFile(file,JSON.stringify({server:{port:3100},database:{embeddedPostgresDataDir:'~/.paperclip/instances/default/db',backup:{dir:'./backups'}}}));try{const result=invoke(['exec',process.execPath,'-e','console.log("STARTED")']);assert.equal(result.status,0,result.stderr);}finally{await writeFile(file,saved);}});
