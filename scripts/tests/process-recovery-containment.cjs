const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {transformSync} = require('esbuild');
const path = require('node:path');
const root = path.resolve(process.argv[2] || process.cwd());
const source = fs.readFileSync(path.join(root, 'server/src/agent-auth-jwt.ts'), 'utf8');
const moduleFixture = {exports: {}};
vm.runInNewContext(transformSync(source, {loader:'ts',format:'cjs',target:'es2022'}).code, {
  module:moduleFixture, exports:moduleFixture.exports, Buffer,
  process:{env:{PAPERCLIP_AGENT_JWT_SECRET:'synthetic-fixture-only',PAPERCLIP_AGENT_JWT_TTL_SECONDS:'120'}},
  require(name) {
    if(name === 'node:crypto') return crypto;
    if(name === '@paperclipai/shared') return {normalizeAgentApiKeyScope:x=>x};
    if(name === './home-paths.js') return {resolvePaperclipInstanceId:()=> 'isolated-fixture'};
    throw Error('Unexpected dependency');
  }
});
const jwt = moduleFixture.exports;
const company = '0000000a-0000-4000-8000-00000000000a';
const historicalRows = [["historical1", "0000000e-0000-4000-8000-00000000000e", "00000011-0000-4000-8000-000000000011", false], ["historical2", "0000000f-0000-4000-8000-00000000000f", "00000012-0000-4000-8000-000000000012", false], ["historical3", "0000000f-0000-4000-8000-00000000000f", "00000013-0000-4000-8000-000000000013", false], ["historical4", "0000000f-0000-4000-8000-00000000000f", "00000014-0000-4000-8000-000000000014", false], ["historical5", "0000000e-0000-4000-8000-00000000000e", "00000015-0000-4000-8000-000000000015", false], ["historical6", "00000010-0000-4000-8000-000000000010", "00000016-0000-4000-8000-000000000016", false]];
const rows = [...historicalRows,
  ['Process','0000000d-0000-4000-8000-00000000000d','0000000b-0000-4000-8000-00000000000b',false],
  ['Runtime','0000000e-0000-4000-8000-00000000000e','0000000c-0000-4000-8000-00000000000c',false],
  ['ordinary','fixture-agent','fixture-run',true]
];
const checks=[];
for(const [name,agent,run,expected] of rows) {
  const token=jwt.createLocalAgentJwt(agent,company,'codex_local',run,'fixture-user');
  for(const strict of [false,true]) checks.push({name,strict,pass:Boolean(jwt.verifyLocalAgentJwt(token,{strictRunAuthority:strict}))===expected});
}
const token=jwt.createLocalAgentJwt('fixture-agent',company,'codex_local','fixture-run','fixture-user');
checks.push({name:'tampered signature',pass:jwt.verifyLocalAgentJwt(token.slice(0,-1)+(token.endsWith('a')?'b':'a'))===null});
console.log(JSON.stringify({sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),checks,passed:checks.filter(x=>x.pass).length,total:checks.length,syntheticOnly:true,liveIncidentClassification:false}));
if(checks.some(x=>!x.pass)) process.exitCode=1;
