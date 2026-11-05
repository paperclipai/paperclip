import { threadId, isMainThread } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const guard = fileURLToPath(new URL('../../../scripts/fixtures/skill-default-cadence-network-guard.cjs', import.meta.url));
const launcher = fileURLToPath(new URL('../../../scripts/test-skill-default-cadence.mjs', import.meta.url));
it('the actual Vitest worker is preloaded with its own PID before fixture execution', () => {
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
function child(code: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-prewire-'));
  const log = path.join(root, 'guard.jsonl');
  try {
    const result = spawnSync(process.execPath, ['--require', guard, '-e', code], { timeout: 5_000, encoding: 'utf8',
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
