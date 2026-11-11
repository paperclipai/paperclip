import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const guard = fileURLToPath(new URL("../../../__tests__/helpers/slack-cloud/prewire.cjs", import.meta.url));
const launcher = fileURLToPath(new URL("../../../../scripts/test-slack-cloud-postgres.mjs", import.meta.url));
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "" });

it.each([
  "require('node:http').get('http://example.invalid')",
  "require('node:https').get('https://example.invalid')",
  "require('node:net').connect(443,'example.invalid')",
  "require('node:tls').connect(443,'example.invalid')",
  "fetch('https://example.invalid')",
  "require('node:net').connect(55448,'127.0.0.1')",
  "require('node:http').get('http://127.0.0.1:1/')",
])("the checked-in guard fails caught unowned transport attempts: %s", operation => {
  const child = spawnSync(process.execPath, ["--require", guard, "-e",
    `let dnsCalls=0; require('node:dns').lookup=()=>{dnsCalls++;throw Error('DNS must not run');}; try { ${operation}; } catch {} console.log(JSON.stringify({...globalThis[Symbol.for('paperclip.slack.fixture.prewire')].stats(),dnsCalls}));`],
  { env: cleanEnv(), encoding: "utf8", timeout: 5_000 });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(98);
  const stats = JSON.parse(child.stdout.trim());
  expect(stats.pid).toBe(child.pid);
  expect(stats.unexpectedAttempts).toHaveLength(1);
  expect(stats.peakPgSockets).toBe(0);
  expect(stats.dnsCalls).toBe(0);
});

it("the same guard allows an actual owned loopback HTTP server and initializes before the child script", () => {
  const child = spawnSync(process.execPath, ["--require", guard, "-e", `
    const http=require('node:http');
    if(process.env.SLACK_GATE_GUARD_PID!==String(process.pid))throw Error('preload missing');
    const server=http.createServer((req,res)=>res.end('owned response'));
    server.listen(0,'127.0.0.1',()=>http.get('http://127.0.0.1:'+server.address().port,response=>{
      let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>server.close(()=>{
        if(body!=='owned response')throw Error('response missing');
        console.log(JSON.stringify(globalThis[Symbol.for('paperclip.slack.fixture.prewire')].stats()));
      }));
    }));`], { env: cleanEnv(), encoding: "utf8", timeout: 5_000 });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toMatchObject({ pid: child.pid, peakPgSockets: 0, unexpectedAttempts: [] });
});

it.each([
  {},
  { PAPERCLIP_SLACK_TEST_DATABASE_URL: "postgres://user@127.0.0.1/live", SLACK_EVENT_TEST_DATABASE_URL: "postgres://user@127.0.0.1/cloud_test" },
  { PAPERCLIP_SLACK_TEST_DATABASE_URL: "postgres://user@127.0.0.1/same_test", SLACK_EVENT_TEST_DATABASE_URL: "postgres://user@127.0.0.1/same_test" },
  { PAPERCLIP_SLACK_TEST_DATABASE_URL: "postgres://user@example.invalid/app_test", SLACK_EVENT_TEST_DATABASE_URL: "postgres://user@127.0.0.1/cloud_test" },
])("the repository launcher rejects unsafe or absent fixture settings before starting Vitest", settings => {
  const child = spawnSync(process.execPath, [launcher], { env: { ...cleanEnv(), ...settings }, encoding: "utf8", timeout: 5_000 });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stderr).toMatch(/test database|loopback|distinct/);
  expect(child.stdout).not.toContain("RUN");
});
