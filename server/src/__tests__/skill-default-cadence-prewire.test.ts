import { threadId, isMainThread } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const guard = fileURLToPath(new URL('../../../scripts/fixtures/skill-default-cadence-network-guard.cjs', import.meta.url));
const launcher = fileURLToPath(new URL('../../../scripts/test-skill-default-cadence.mjs', import.meta.url));
const prewireRequested = Object.hasOwn(process.env, 'PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG')
  || process.env.PAPERCLIP_MAINTENANCE_PG0_CONTROLS === '1'
  || process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_ACCEPTANCE === '1';
it.skipIf(!prewireRequested)('the actual Vitest worker is preloaded with its own PID before fixture execution', () => {
  const guardState = (globalThis as any)[Symbol.for('paperclip.skill.default-cadence.prewire')];
  expect(guardState).toBeDefined();
  const observed = guardState.stats();
  expect(observed.pid).toBe(process.pid); expect(observed.preload).toBe(guard);
  expect(observed.threadId).toBe(threadId); expect(observed.isMainThread).toBe(isMainThread);
  const receipts = readFileSync(process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(receipts).toContainEqual(expect.objectContaining({ event: 'preloaded', pid: process.pid, threadId, isMainThread, sourceHash: observed.sourceHash }));
  expect(observed.unexpectedAttempts).toEqual([]);
  console.info(JSON.stringify({ actualVitestWorkerGuard: observed }));
});
function child(code: string, extra: Record<string, string> = {}, nodeArgs: string[] = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-prewire-'));
  const log = path.join(root, 'guard.jsonl');
  try {
    const result = spawnSync(process.execPath, ['--require', guard, ...nodeArgs, '-e', code], { timeout: 5_000, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: root, NODE_OPTIONS: '', PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG: log, ...extra } });
    const events = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { result, events };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const stats = "globalThis[Symbol.for('paperclip.skill.default-cadence.prewire')].stats()";
it.each([
  "require('node:http').get('http://example.invalid/')",
  "require('node:https').get('https://example.invalid/')",
  "require('node:net').connect(443,'example.invalid')",
  "require('node:tls').connect(443,'example.invalid')",
  "fetch('https://example.invalid/')",
  "require('node:dns').lookup('example.invalid',()=>{})",
  "require('node:dns').promises.resolve4('example.invalid')",
  "new(require('node:net').Socket)().connect([{host:'example.invalid',port:443},()=>{}])",
  "require('node:net').connect(55448,'127.0.0.1')",
  "require('node:net').connect(require('node:path').join(require('node:os').tmpdir(),'tsx-'+process.getuid(),(process.ppid+12345)+'.pipe'))",
])('preload rejects and records a caught unowned transport: %s', operation => {
  const { result, events } = child(`try { ${operation}; } catch {} console.log(JSON.stringify(${stats}));`);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(98);
  const observed = JSON.parse(result.stdout.trim());
  expect(observed.pid).toBe(result.pid); expect(observed.unexpectedAttempts).toHaveLength(1);
  expect(observed.peakPgSockets).toBe(0);
  expect(events[0]).toMatchObject({ event: 'preloaded', pid: result.pid });
  expect(events.filter(event => event.event === 'blocked')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ event: 'exit', exitCode: 98 });
});
it('checks an overriding HTTP hostname even when the URL names a real owned listener', () => {
  const { result, events } = child(`const http=require('node:http');let dnsCalls=0;
    const server=http.createServer();server.listen(0,'127.0.0.1',()=>{
      require('node:dns').lookup=()=>{dnsCalls++;throw Error('DNS must not run');};
      try{http.get(new URL('http://127.0.0.1:'+server.address().port),{hostname:'example.invalid'});}catch{}
      server.close(()=>console.log(JSON.stringify({...${stats},dnsCalls})));
    });`);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(98);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ dnsCalls: 0, unexpectedAttempts: ['offhost example.invalid'] });
  expect(events.filter(event => event.event === 'blocked')).toHaveLength(1);
});
it('never permits an existing Unix path even for the exact current parent', () => {
  const { result, events } = child(`const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
    const dir=path.join(os.tmpdir(),'tsx-'+process.getuid());fs.mkdirSync(dir,{recursive:true});
    const pipe=path.join(dir,process.ppid+'.pipe');fs.writeFileSync(pipe,'not a socket');
    try{require('node:net').connect(pipe);}catch{}console.log(JSON.stringify(${stats}));`);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(98);
  expect(events.filter(event => event.event === 'blocked')).toHaveLength(1);
});
it('permits actual owned loopback HTTP only after the real listener binds', () => {
  const { result, events } = child(`const http=require('node:http'); const server=http.createServer((req,res)=>res.end('useful response'));
    server.listen(0,'127.0.0.1',()=>http.get('http://127.0.0.1:'+server.address().port,res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>server.close(()=>{
        if(body!=='useful response')throw Error('missing useful body');console.log(JSON.stringify(${stats}));
      }));
    }));`);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ pid: result.pid, loaded: true, unexpectedAttempts: [] });
  expect(events.at(-1)).toMatchObject({ event: 'exit', exitCode: 0 });
});
it('permits only an absent current live-parent TSX probe and records the actual ENOENT', () => {
  const { result, events } = child(`const path=require('node:path'),os=require('node:os');
    const socket=require('node:net').connect(path.join(os.tmpdir(),'tsx-'+process.getuid(),process.ppid+'.pipe'));
    socket.on('error',error=>{if(error.code!=='ENOENT')throw error;console.log(JSON.stringify(${stats}));});`);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim()).unexpectedAttempts).toEqual([]);
  expect(events.filter(event => event.event === 'current-parent-pipe-ENOENT')).toHaveLength(1);
});
it.each([{},
  { PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL: 'postgres://u@127.0.0.1/live', PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL: 'postgres://u@127.0.0.1/cloud_test' },
  { PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL: 'postgres://u@127.0.0.1/same_test', PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL: 'postgres://u@127.0.0.1/same_test' },
  { PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL: 'postgres://u@example.invalid/app_test', PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL: 'postgres://u@127.0.0.1/cloud_test' },
])('launcher refuses absent/unsafe settings before loading Vitest', settings => {
  const result = spawnSync(process.execPath, [launcher], { timeout: 5_000, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_OPTIONS: '', ...settings } });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/test database|loopback|distinct/); expect(result.stdout).not.toContain('RUN');
});

it('permits approved HTTP options with a request path and default port through an owned agent', () => {
  const { result } = child(`const http=require('node:http'),net=require('node:net');
    const state=globalThis[Symbol.for('paperclip.skill.default-cadence.prewire')];let agentCalls=0;
    const server=http.createServer((req,res)=>res.end('approved options response'));
    server.listen(0,'127.0.0.1',()=>{
      state.allowOrigin('http://127.0.0.1');
      const agent=new http.Agent();agent.createConnection=()=>{agentCalls++;return net.connect(server.address().port,'127.0.0.1');};
      http.get({host:'127.0.0.1',path:'/useful',agent},res=>{let body='';res.on('data',chunk=>body+=chunk);
        res.on('end',()=>{agent.destroy();server.close(()=>console.log(JSON.stringify({...state.stats(),body,agentCalls})));});});
    });`);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ body: 'approved options response', agentCalls: 1, unexpectedAttempts: [] });
});
it.each([
  ['unknown.example.invalid', 'offhost unknown.example.invalid'],
  ['127.0.0.1', 'unowned loopback 127.0.0.1:80'],
])('rejects an unknown HTTP options origin before agent work: %s', (host, reason) => {
  const { result } = child(`const http=require('node:http');let agentCalls=0;const agent=new http.Agent();
    agent.createConnection=()=>{agentCalls++;throw Error('Agent must not run');};
    try{http.get({host:${JSON.stringify(host)},path:'/',agent});}catch{}
    console.log(JSON.stringify({...${stats},agentCalls}));`);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(98);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ agentCalls: 0, unexpectedAttempts: [reason] });
});
it('joins an admitted deferred wake and closes its real child listener before bridge close returns', () => {
  const bridgeSource = process.env.PAPERCLIP_SKILL_BRIDGE_CONTROL_SOURCE
    ?? fileURLToPath(new URL('./helpers/maintenance/default-cadence-bridge.ts', import.meta.url));
  const networkSource = fileURLToPath(new URL('./helpers/maintenance/default-cadence-network.ts', import.meta.url));
  const loader = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const { result, events } = child(String.raw`(async()=>{
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
    const {fork}=require('node:child_process'),{pathToFileURL}=require('node:url');
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const ipcErrors=[];process.on('uncaughtException',error=>{if(error.code!=='ERR_IPC_CHANNEL_CLOSED')throw error;ipcErrors.push({code:error.code,message:error.message});});
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-close-')),app=path.join(root,'app');
    const helpers=path.join(app,'server/src/__tests__/helpers/maintenance');fs.mkdirSync(helpers,{recursive:true});
    fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({type:'module'}));
    const source=path.join(helpers,'default-cadence-bridge.ts');fs.copyFileSync(process.env.BRIDGE_SOURCE,source);
    fs.copyFileSync(process.env.NETWORK_SOURCE,path.join(helpers,'default-cadence-network.ts'));
    const preload=path.join(app,'scripts/fixtures/skill-default-cadence-network-guard.cjs');fs.mkdirSync(path.dirname(preload),{recursive:true});fs.copyFileSync(process.env.GUARD_SOURCE,preload);
    const checkout=path.join(root,'cloud'),entry=path.join(checkout,'dist/sleep/fixtures/default-cadence-bridge.js');fs.mkdirSync(path.dirname(entry),{recursive:true});
    fs.writeFileSync(entry,[
      "process.on('message',message=>{if(message.method==='trigger'){process.send({callbackId:'wake',physical:'wake'},()=>process.exit(0));}else if(message.method==='close'){process.send({id:message.id,result:true});}});",
      "process.send({ready:true,pid:process.pid,defaultCadenceGuard:globalThis[Symbol.for('paperclip.skill.default-cadence.prewire')].stats()});"
    ].join('\n'));
    const physicalFile=path.join(root,'physical-app.cjs');fs.writeFileSync(physicalFile,[
      "const http=require('node:http');const server=http.createServer((req,res)=>res.end('late real child'));",
      "server.listen(0,'127.0.0.1',()=>process.send({origin:'http://127.0.0.1:'+server.address().port}));",
      "process.on('message',message=>{if(message.stop)server.close(()=>process.disconnect());});"
    ].join('\n'));
    let release,start,finish,fail,physical,physicalExit,origin,body,physicalOutput='',stops=0;
    const released=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{start=resolve;}),finished=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
    const state=globalThis[Symbol.for('paperclip.skill.default-cadence.prewire')];
    const stop=async()=>{stops++;if(physical&&physical.exitCode===null){
      if(physical.connected)physical.send({stop:true});else physical.kill('SIGTERM');
      await Promise.race([physicalExit,delay(1000).then(async()=>{if(physical.exitCode===null)physical.kill('SIGKILL');await physicalExit;})]);
    }};
    const {startDefaultCadenceBridge}=await import(pathToFileURL(source).href);let bridge;
    try{
      bridge=await startDefaultCadenceBridge({checkout,node:process.execPath,physicalStop:stop,physicalWake:async()=>{
        start();await released;
        try{
        physical=fork(physicalFile,[],{execArgv:['--require',preload],env:process.env,stdio:['ignore','ignore','pipe','ipc']});
        physical.stderr.on('data',bytes=>{physicalOutput+=String(bytes);});
        physicalExit=new Promise(resolve=>physical.once('exit',resolve));
        origin=await new Promise((resolve,reject)=>{physical.once('message',message=>resolve(message.origin));physical.once('error',reject);physical.once('exit',code=>reject(Error('Physical child exited before origin: '+code+' '+physicalOutput)));});
        state.allowOrigin(origin);body=await(await fetch(origin)).text();finish();return{origin};
        }catch(error){fail(error);throw error;}
      }});
      const trigger=bridge.rpc('trigger').then(()=>null,error=>String(error));await started;await trigger;
      const closing=bridge.close().then(()=>({ok:true}),error=>({ok:false,error:String(error)}));
      const closedEarly=await Promise.race([closing.then(()=>true),delay(40).then(()=>false)]);
      release();await finished;const closed=await closing;
      let reachable=false;try{reachable=(await fetch(origin)).ok;}catch{}
      console.log(JSON.stringify({...state.stats(),body,closedEarly,closed,reachable,stops,origin,ipcErrors,physicalPid:physical.pid,physicalExitCode:physical.exitCode}));
      assert.equal(body,'late real child');assert.equal(reachable,false,'Late child listener remained reachable after bridge.close');
      assert.equal(physical.exitCode,0);assert.equal(stops,1);assert.equal(closedEarly,false);assert.equal(closed.ok,true);assert.deepEqual(ipcErrors,[]);
    }finally{
      release();if(physical&&physical.exitCode===null)await stop();fs.rmSync(root,{recursive:true,force:true});
    }
  })().catch(error=>{console.error(error.stack);process.exitCode=1;});`, {
    BRIDGE_SOURCE: bridgeSource, NETWORK_SOURCE: networkSource, GUARD_SOURCE: guard,
  }, ['--import', loader]);
  const diagnostics = JSON.stringify({ stdout: result.stdout, stderr: result.stderr, events });
  expect(result.error, diagnostics).toBeUndefined(); expect(result.status, diagnostics).toBe(0);
  const observation = result.stdout.trim().split('\n').at(-1)!;
  expect(observation, diagnostics).toMatch(/^\{/);
  console.info(JSON.stringify({ cleanupObservation: JSON.parse(observation), guardEvents: events }));
  expect(JSON.parse(observation)).toMatchObject({
    body: 'late real child', closedEarly: false, closed: { ok: true }, reachable: false, stops: 1, physicalExitCode: 0, ipcErrors: [], unexpectedAttempts: [],
  });
});
