#!/usr/bin/env -S node --import tsx
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { xspawn, xspawnSync, WHICH, IS_WIN } from './cross-platform.ts';
import { DesignerController } from './designer-controller.ts';
import { listSessions, getSession } from './session-store.ts';
import { createBrowser } from './browser.ts';
import { writeTastingHtml, serveAndOpen } from './tasting.ts';
import { sessionDir } from './artifact-store.ts';
import { runSetup } from './setup.ts';
import { startMcpServer } from './mcp-server.ts';
import { REPO_ROOT } from './repo-root.ts';
import { runHealth } from './ui-anchors.ts';
import { maybeRenewLease } from './lease-renew.js';

const [, , cmd, ...rest] = process.argv;

type FlagValue = string | boolean | undefined;
interface Flags {
  _: string[];
  [k: string]: FlagValue | string[];
}

function parseFlags(args: string[]): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const parts = a.slice(2).split('=');
      const k = parts[0] ?? '';
      const v = parts[1] ?? args[++i] ?? true;
      if (k) out[k] = v as FlagValue;
    } else {
      (out._ as string[]).push(a);
    }
  }
  return out;
}

const flags = parseFlags(rest);
const key = (flags.key as string) || 'default';

async function main(): Promise<void> {
  // Honor --help / -h at the top: `designer <verb> --help` prints just that verb's
  // expanded docs. Done here rather than in each case so every verb gets it free.
  if (flags.help === true || flags.h === true) {
    if (cmd && HELP[cmd]) {
      console.log(HELP[cmd]);
    } else {
      console.log(TOP_HELP);
    }
    return;
  }

  switch (cmd) {
    case 'open': {
      await maybeRenewLease();
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.ensureReady(), null, 2));
      break;
    }
    case 'session': {
      await maybeRenewLease();
      const c = new DesignerController({ key });
      const action = (flags.action as 'status' | 'ensure_ready' | 'resume' | 'create') || 'status';
      const name = flags.name as string | undefined;
      const fidelity = flags.fidelity as 'wireframe' | 'highfi' | undefined;
      console.log(JSON.stringify(await c.session({ action, name, fidelity }), null, 2));
      break;
    }
    case 'prompt': {
      await maybeRenewLease();
      const prompt = await readPromptArg(flags);
      if (!prompt) throw new Error('Usage: designer prompt "<text>" | - (stdin) | --prompt-file path [--key k] [--file "f.html"]');
      const c = new DesignerController({ key });
      const res = await c.iterate(prompt, {
        file: flags.file as string | undefined,
        timeoutMs: flags.timeoutMs ? Number(flags.timeoutMs) : undefined,
        stabilityMs: flags.stabilityMs ? Number(flags.stabilityMs) : undefined,
        decisive: Boolean(flags.decisive)
      });
      if (res.url) console.log(`\nTaste here: ${res.url}\n`);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'create': {
      await maybeRenewLease();
      const name = (flags.name as string) || flags._[0];
      if (!name) throw new Error('Usage: designer create <name> [--fidelity wireframe|highfi] [--key k]');
      const fidelity = (flags.fidelity as 'wireframe' | 'highfi') || 'wireframe';
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.createSession(name, fidelity), null, 2));
      break;
    }
    case 'resume': {
      await maybeRenewLease();
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.resumeSession(), null, 2));
      break;
    }
    case 'snapshot': {
      await maybeRenewLease();
      const c = new DesignerController({ key });
      await c.ensureReady();
      const filename = flags.file as string | undefined;
      if (filename) await c.openFile(filename);
      const snap = await c.snapshotDesign();
      if (snap.url) console.log(`\nTaste here: ${snap.url}\n`);
      console.log(
        JSON.stringify(
          { file: filename ?? null, url: snap.url, htmlBytes: snap.html?.length || 0, screenshotPath: snap.screenshotPath },
          null,
          2
        )
      );
      break;
    }
    case 'status':
      console.log(JSON.stringify(getSession(key) || { key, empty: true }, null, 2));
      break;
    case 'list':
      console.log(JSON.stringify(listSessions(), null, 2));
      break;
    case 'projects': {
      await maybeRenewLease();
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.listProjects(), null, 2));
      break;
    }
    case 'files': {
      await maybeRenewLease();
      const c = new DesignerController({ key });
      const detail = await c.listFilesDetailed();
      if (!detail.authoritative) {
        console.error(
          `[designer] Folders detected (${detail.folders.join(', ')}) — files under them are invisible to the live scrape. Run 'designer handoff --key ${key}' for authoritative file listing.`
        );
      }
      console.log(JSON.stringify(detail, null, 2));
      break;
    }
    case 'open-file': {
      await maybeRenewLease();
      const filename = flags._.join(' ');
      if (!filename) throw new Error('Usage: designer open-file "<name>.html" --key k');
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.openFile(filename), null, 2));
      break;
    }
    case 'ask': {
      await maybeRenewLease();
      const prompt = await readPromptArg(flags);
      if (!prompt) throw new Error('Usage: designer ask "<text>" | - (stdin) | --prompt-file path --key k');
      const c = new DesignerController({ key });
      const r = await c.ask(prompt, {
        file: flags.file as string | undefined,
        timeoutMs: flags.timeoutMs ? Number(flags.timeoutMs) : undefined,
        stabilityMs: flags.stabilityMs ? Number(flags.stabilityMs) : undefined
      });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'handoff': {
      await maybeRenewLease();
      const c = new DesignerController({ key });
      const r = await c.handoff({ openFile: flags.file as string | undefined });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'fetch': {
      await maybeRenewLease();
      const filename = flags._.join(' ');
      if (!filename) throw new Error('Usage: designer fetch "<name>.html" --key k [--out path]');
      const c = new DesignerController({ key });
      const r = await c.fetchFile(filename);
      if (flags.out) {
        fs.writeFileSync(flags.out as string, r.html);
        console.log(JSON.stringify({ file: r.file, htmlBytes: r.htmlBytes, written: flags.out }, null, 2));
      } else {
        console.log(
          JSON.stringify(
            { file: r.file, htmlBytes: r.htmlBytes, iframeSrc: r.iframeSrc, htmlPreview: r.html.slice(0, 200) },
            null,
            2
          )
        );
      }
      break;
    }
    case 'close': {
      await createBrowser({ session: `designer-${key}` }).close();
      console.log('closed');
      break;
    }
    case 'mcp': {
      const sub = flags._[0];
      if (sub !== 'serve') {
        console.log("Usage: designer mcp serve\n  Starts the MCP stdio server. Used in 'claude mcp add --transport stdio designer -- designer mcp serve'.");
        process.exit(sub ? 2 : 0);
      }
      await startMcpServer();
      break;
    }
    case 'setup': {
      const code = await runSetup();
      process.exit(code);
    }
    case 'health': {
      const browser = createBrowser({ session: `designer-${key}` });
      const results = await runHealth(browser);
      const counts = results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {});
      const fail = results.some((r) => r.status === 'fail');
      const url = (await browser.url().catch(() => '')) || '';
      if (flags.json === true || flags.json === '') {
        const payload = {
          ok: !fail,
          generatedAt: new Date().toISOString(),
          url,
          counts: { ok: counts['ok'] || 0, fail: counts['fail'] || 0, skip: counts['skip'] || 0 },
          results
        };
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const icon = (s: string) => (s === 'ok' ? '✓' : s === 'fail' ? '✗' : '·');
        for (const r of results) {
          const line = `${icon(r.status)} [${r.category}] ${r.id} — ${r.description}${r.detail ? ' (' + r.detail + ')' : ''}`;
          console.log(line);
        }
        console.log(`\n${counts['ok'] || 0} ok, ${counts['fail'] || 0} fail, ${counts['skip'] || 0} skip`);
      }
      if (fail) process.exit(2);
      break;
    }
    case 'doctor': {
      const checks = await runDoctor();
      const fail = checks.some((c) => c.status === 'fail');
      console.log(checks.map((c) => `${statusIcon(c.status)} ${c.name}${c.detail ? ' — ' + c.detail : ''}`).join('\n'));
      if (fail) process.exit(2);
      break;
    }
    case 'tasting': {
      const base = sessionDir(key);
      const handoffs = fs
        .readdirSync(base)
        .filter((e) => e.startsWith('handoff-'))
        .map((e) => path.join(base, e))
        .filter((p) => fs.statSync(p).isDirectory())
        .sort();
      const latest = handoffs[handoffs.length - 1];
      if (!latest) throw new Error(`No handoff bundle found for key=${key}. Run 'designer handoff --key ${key}' first.`);
      const slugDirs = fs
        .readdirSync(latest)
        .filter((e) => e !== 'bundle.tar.gz')
        .map((e) => path.join(latest, e))
        .filter((p) => fs.statSync(p).isDirectory());
      const slugDir = slugDirs[0];
      if (!slugDir) throw new Error('Bundle has no project subdirectory.');
      const projectDir = path.join(slugDir, 'project');
      if (!fs.existsSync(projectDir)) throw new Error(`Missing ${projectDir}`);

      // Walk recursively — Claude Design organizes variants under folders
      // (e.g. directions/*.html) often enough that flat readdir misses them.
      // Paths are stored relative to projectDir so iframe hrefs can point
      // at them directly over the local HTTP server.
      const files: string[] = [];
      const stack = [''];
      while (stack.length) {
        const rel = stack.pop()!;
        const abs = path.join(projectDir, rel);
        for (const entry of fs.readdirSync(abs)) {
          const childRel = rel ? path.join(rel, entry) : entry;
          const childAbs = path.join(projectDir, childRel);
          if (fs.statSync(childAbs).isDirectory()) {
            stack.push(childRel);
            continue;
          }
          if (!entry.endsWith('.html') || entry === 'tasting.html' || entry === 'index.html') continue;
          files.push(childRel);
        }
      }
      if (files.length === 0) throw new Error('No .html variants found in bundle project dir.');

      const variants = files.map((f) => ({
        name: prettyName(path.basename(f)),
        file: f
      }));

      const tastingPath = writeTastingHtml({ projectDir, variants, title: key });
      const { url, port, pid } = await serveAndOpen(projectDir, { file: 'tasting.html' });
      console.log(JSON.stringify({ ok: true, tastingPath, url, port, serverPid: pid, variants }, null, 2));
      break;
    }
    case '--help':
    case '-h':
    case 'help':
    case undefined:
    default: {
      const verb = cmd === 'help' ? flags._[0] : cmd && cmd !== '--help' && cmd !== '-h' ? cmd : undefined;
      if (verb && HELP[verb]) {
        console.log(HELP[verb]);
      } else {
        console.log(TOP_HELP);
      }
      if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h' && cmd !== undefined && !HELP[cmd]) {
        process.exit(1);
      }
    }
  }
}

const TOP_HELP = `designer — CLI + MCP for iterating on claude.ai/design

Typical loop:
  designer setup                                       (once per machine)
  designer session --action create --name "X" --key x  start a project
  designer prompt "design the …" --key x               prints 'Taste here: <url>'  ← open that
  designer prompt - --key x < follow-up.txt            iterate until human says yes
  designer handoff --key x                             bundle for code implementation

Session lifecycle:
  session [--action status|ensure_ready|resume|create] [--name N] [--fidelity wireframe|highfi] [--key k]
                                               enter/inspect/transition (primary entry)
  status [--key k]                             read stored state
  list                                         list locally-tracked sessions
  close [--key k]                              close browser (state preserved)

Design operations (prompt + snapshot print 'Taste here: <url>' above the JSON):
  prompt "<text>" | - | --prompt-file p [--key k] [--file f.html] [--timeoutMs n] [--stabilityMs n]
  ask    "<text>" | - | --prompt-file p [--key k] [--file f.html]
  snapshot [--key k] [--file f.html]

File / project introspection:
  projects                                     all Claude projects (scrapes home)
  files [--key k]                              files in current project
  open-file "<name>.html" [--key k]            switch open file
  fetch "<name>.html" [--key k] [--out p]      fetch served HTML to disk

Exit / promotion:
  handoff [--key k] [--file "<name>.html"]     download tar.gz bundle (README + chats + source)
  tasting [--key k]                            local full-viewport switcher for the latest bundle
                                               (fallback when Claude's URL framing hurts taste)

Setup / ops:
  setup                                        one-call first-run
  doctor                                       diagnose setup state
  health                                       probe every UI anchor we depend on

Internal:
  mcp serve                                    start MCP stdio server ('claude mcp add' uses this)

All verbs accept --key <k> for parallel isolation.
Env: DESIGNER_CDP=9222 (auto-detected after 'designer setup').

Per-verb detail: designer help <verb>   or   designer <verb> --help`;

const HELP: Record<string, string> = {
  session: `designer session — enter, inspect, or transition a claude.ai/design session.

Flags:
  --action <a>    status (default, read-only) | ensure_ready | resume | create
  --name <N>      required when --action create
  --fidelity <f>  wireframe | highfi — locked at creation, default wireframe
  --key <k>       stable session key (e.g., feature name), defaults to 'default'

Examples:
  designer session                                        # read status of 'default'
  designer session --action create --name "feat X" --fidelity highfi --key feat-x
  designer session --action resume --key feat-x
  designer session --key feat-x                           # status for feat-x`,

  prompt: `designer prompt — modify the design. Waits for HTML to change and stabilize.

Input (pick one):
  "<text>"                literal argument (positional)
  -                       read from stdin
  --prompt-file <path>    read from file

Flags:
  --key <k>               session to target (default: 'default')
  --file <f.html>         switch to this file before prompting
  --timeoutMs <n>         default 20 minutes
  --stabilityMs <n>       default 4 seconds
  --decisive              tell Claude not to stop on clarifying questions; pick defaults and proceed

Output: prints 'Taste here: <url>' then JSON metadata (done, newFiles, htmlPath, screenshotPath,
htmlHash, chatReply). HTML is written to disk (read htmlPath if needed); it's not inline.

Auto-appended to every prompt: 'Keep all generated files at the project root; no subfolders.'
Override by explicitly contradicting it in your prompt text.

With --decisive, also append: 'If you would otherwise stop to ask clarifying questions, do not.
Choose the most defensible answer for each axis yourself and proceed.' Use when you want Claude
to commit to a direction instead of blocking on the clarifying-questions affordance.

Examples:
  designer prompt "add a Remember-me checkbox" --key feat-x
  designer prompt --prompt-file ./brief.md --key feat-x
  cat follow-up.txt | designer prompt - --key feat-x`,

  ask: `designer ask — Q&A with the design assistant. No file changes; returns the reply.

Input (pick one):
  "<text>"                literal argument
  -                       read from stdin
  --prompt-file <path>    read from file

Flags:
  --key <k>               session to target
  --file <f.html>         switch to this file first (gives Claude context)
  --timeoutMs <n>         default 5 minutes

Output: JSON with { ok, reply, elapsedMs, failureMode }.

Use for 'why did you choose X?', 'compare A and B', 'suggest 3 alternatives before I commit'.
Distinct from prompt because it watches the chat panel, not the served HTML.`,

  snapshot: `designer snapshot — capture current design state without prompting.

Flags:
  --key <k>               session to target
  --file <f.html>         switch to this file first

Output: prints 'Taste here: <url>' then JSON with { file, url, htmlBytes, screenshotPath }.
Useful when you want to inspect a variant or save the current state to disk without iterating.`,

  handoff: `designer handoff — trigger Export→Handoff and download the tar.gz bundle.

Flags:
  --key <k>               session to target
  --file <name.html>      switch to this file first (marks it as the primary in the bundle)

Bundle contains:
  README.md       handoff protocol for the implementing agent
  chats/chat1.md  full transcript — every prompt + reply, verbatim (the decision record)
  project/*       all design files (HTML, standalone HTML, JSX, CSS)

Lands under ./artifacts/{key}/handoff-{timestamp}/. Non-optional for code promotion — the
implementing agent (Claude Code downstream) reads README + chats first, then builds in real code.`,

  tasting: `designer tasting — build a local full-viewport switcher over the latest handoff bundle.

Flags:
  --key <k>               session to target
  --port <n>              default auto-assigned from 8765

What it does: walks the latest handoff's project/ dir, writes tasting.html with variant tabs
(keyboard 1/N to switch) + notes field (persisted in localStorage), starts http.server, opens
the browser.

Use when Claude.ai/design's IDE chrome (chat panel, toolbar) is stealing viewport space that
the design needs for judgment. Requires a prior 'designer handoff'.`,

  setup: `designer setup — one-call first-run for this machine.

Runs in order, idempotent at every step:
  1. npm install (if missing)
  2. Check agent-browser on PATH
  3. If non-debug Chrome running → ask you to Cmd+Q, poll until quit
  4. Auto-launch debug Chrome with --remote-debugging-port + dedicated --user-data-dir
  5. Poll until you sign in to Claude and reach /design
  6. Copy the designer-loop skill to ~/.claude/skills/
  7. Register the MCP server with Claude Code at user scope

Re-run any time; every step no-ops when already satisfied.`,

  doctor: `designer doctor — diagnose first-run setup state without changing anything.

Checks: agent-browser on PATH, CDP reachable at DESIGNER_CDP port, a /design tab is open,
selectors.json present, designer-loop skill installed at ~/.claude/skills/, MCP registration.

Exits with code 2 if any check fails.`,

  health: `designer health [--json] — probe every UI anchor this MCP depends on.

Walks the current Chrome state (home / session) and checks each selector / button / URL /
DOM pattern we rely on. Reports pass / fail / skip per anchor with actionable detail.

Flags:
  --json     Emit a structured { ok, generatedAt, url, counts, results } JSON payload
             on stdout instead of icons. Exit code is unchanged.

Exit code 2 on any fail — wire into cron or CI to catch UI regressions (e.g., claude.ai
moving the Share button) before users do.`,

  'mcp': `designer mcp serve — start the MCP stdio server.

Used by 'claude mcp add':
  claude mcp add --transport stdio designer -- env DESIGNER_CDP=9222 designer mcp serve

Handled automatically by 'designer setup'.`,

  files: `designer files — list filenames in the current project (scrapes the design-files panel).

Flags: --key <k>

Note: the scrape is flat-only. Files nested under folders (directions/, variants/) are
invisible to this command. The handoff bundle is always folder-aware — use that for
authoritative file listing.`,

  projects: `designer projects — list all Claude design projects visible on /design home.

Output: JSON array of { name, sub (subtitle, e.g., 'Today'), url }.`,

  'open-file': `designer open-file "<name>.html" — switch the currently-open file in the project.

Flags: --key <k>

URL-encodes the filename and navigates to ?file=<name>. Useful mid-iteration.`,

  fetch: `designer fetch "<name>.html" — fetch a file's served HTML.

Flags:
  --key <k>
  --out <path>   write HTML to this path

Without --out, returns JSON with a 200-char preview. With --out, writes the full HTML and
returns { file, htmlBytes, written }.`,

  close: `designer close — close the browser (state on disk is preserved).

Flags: --key <k>

Rarely needed; the debug Chrome window persists across designer calls. Primary use is
test cleanup.`,

  status: `designer status — print stored state for a session.

Flags: --key <k>

Output: the full session record from ~/.designer/sessions.json — createdAt, designUrl,
name, fidelity, lastUrl, full history.`,

  list: `designer list — list all locally-tracked sessions from ~/.designer/sessions.json.

No flags. Output: JSON array of session records.`
};

type DoctorStatus = 'ok' | 'warn' | 'fail';
interface DoctorCheck { name: string; status: DoctorStatus; detail?: string }

function statusIcon(s: DoctorStatus): string {
  return s === 'ok' ? '✓' : s === 'warn' ? '⚠' : '✗';
}

async function runDoctor(): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];

  out.push(checkDeps());
  out.push(await checkAgentBrowser());
  out.push(await checkCdp());
  out.push(await checkOnDesignSurface());
  out.push(checkSelectors());
  out.push(checkSkillInstalled());
  out.push(await checkMcpRegistered());

  return out;
}

function checkDeps(): DoctorCheck {
  const rootLock = path.join(REPO_ROOT, 'package-lock.json');
  // Installed-mode (npx / bunx / pnpm): no package-lock shipped, deps live
  // outside the package dir. If we got this far, the package manager placed them.
  if (!fs.existsSync(rootLock)) {
    return { name: 'dependencies installed', status: 'ok', detail: 'installed-mode' };
  }
  const nm = path.join(REPO_ROOT, 'node_modules');
  if (!fs.existsSync(nm)) {
    return { name: 'dependencies installed', status: 'fail', detail: 'node_modules missing — run `npm install`' };
  }
  const innerLock = path.join(nm, '.package-lock.json');
  if (!fs.existsSync(innerLock)) {
    return { name: 'dependencies installed', status: 'ok', detail: 'node_modules present (no inner lockfile)' };
  }
  const h = (p: string): string => createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  if (h(rootLock) !== h(innerLock)) {
    return { name: 'dependencies installed', status: 'warn', detail: 'node_modules stale (lockfile mismatch) — run `npm install`' };
  }
  return { name: 'dependencies installed', status: 'ok', detail: 'in sync with package-lock' };
}

async function checkAgentBrowser(): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const c = xspawn('agent-browser', ['--version'], { stdio: 'pipe' });
    let v = '';
    c.stdout!.on('data', (d: Buffer) => (v += d.toString()));
    c.on('error', () => resolve({ name: 'agent-browser installed', status: 'fail', detail: 'binary not found on PATH; install from https://github.com/agent-browser/agent-browser' }));
    c.on('close', () => resolve({ name: 'agent-browser installed', status: 'ok', detail: v.trim() || 'present' }));
  });
}

async function checkCdp(): Promise<DoctorCheck> {
  const port = process.env.DESIGNER_CDP || '9222';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!res.ok) return { name: `CDP at port ${port}`, status: 'fail', detail: `HTTP ${res.status}` };
    const j = await res.json() as { Browser?: string };
    return { name: `CDP at port ${port}`, status: 'ok', detail: j.Browser || 'connected' };
  } catch (e) {
    return {
      name: `CDP at port ${port}`,
      status: 'fail',
      detail: `not reachable. Run: ${IS_WIN ? 'powershell scripts\\designer-chrome.ps1' : './scripts/designer-chrome.sh'} (launches Chrome with --remote-debugging-port=${port} in a dedicated profile)`
    };
  }
}

async function checkOnDesignSurface(): Promise<DoctorCheck> {
  const port = process.env.DESIGNER_CDP || '9222';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) {
      return {
        name: 'claude.ai/design tab',
        status: 'fail',
        detail: `CDP HTTP ${res.status} — debug Chrome may have died. Run \`designer setup\` to relaunch it.`
      };
    }
    const tabs = await res.json() as Array<{ url?: string; title?: string }>;
    const onDesign = tabs.find((t) => t.url && /claude\.ai\/design/.test(t.url));
    if (!onDesign) {
      return {
        name: 'claude.ai/design tab',
        status: 'warn',
        detail: 'no tab on claude.ai/design in the debug Chrome window. Open https://claude.ai/design THERE (not in your normal Chrome — they are separate profiles with separate cookies).'
      };
    }
    if (/login|sign in/i.test(onDesign.title || '')) {
      return {
        name: 'signed in to claude.ai/design',
        status: 'fail',
        detail: 'on a login page. Sign in INSIDE the debug Chrome window (not your normal Chrome — that profile is signed in but its cookies are not shared).'
      };
    }
    return { name: 'signed in to claude.ai/design', status: 'ok', detail: onDesign.url };
  } catch {
    return {
      name: 'claude.ai/design tab',
      status: 'fail',
      detail: 'debug Chrome unreachable. Run `designer setup` to launch it.'
    };
  }
}

function checkSelectors(): DoctorCheck {
  try {
    fs.readFileSync(path.join(REPO_ROOT, 'selectors.json'), 'utf8');
    return { name: 'selectors.json present', status: 'ok' };
  } catch {
    return { name: 'selectors.json present', status: 'fail', detail: 'missing — re-clone or restore from git' };
  }
}

function checkSkillInstalled(): DoctorCheck {
  const home = process.env.HOME || '';
  const skillDir = path.join(home, '.claude', 'skills', 'designer-loop');
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    return { name: 'designer-loop skill installed', status: 'warn', detail: `not at ${skillPath}; agent will lack loop guidance` };
  }
  try {
    if (fs.lstatSync(skillDir).isSymbolicLink()) {
      return { name: 'designer-loop skill installed', status: 'ok', detail: `${skillDir} → ${fs.realpathSync(skillDir)}` };
    }
  } catch {}
  return { name: 'designer-loop skill installed', status: 'ok', detail: skillDir };
}

async function checkMcpRegistered(): Promise<DoctorCheck> {
  const which = xspawnSync(WHICH, ['claude'], { stdio: 'pipe' });
  if (which.status !== 0) {
    return { name: 'MCP registered with Claude Code', status: 'warn', detail: 'claude CLI not on PATH; install Claude Code to verify' };
  }
  const list = xspawnSync('claude', ['mcp', 'list'], { stdio: 'pipe' });
  if (list.status !== 0) {
    return { name: 'MCP registered with Claude Code', status: 'fail', detail: `\`claude mcp list\` exited ${list.status}` };
  }
  const stdout = list.stdout?.toString() || '';
  const line = stdout.split('\n').find((l) => /(\s|^)designer\b/i.test(l));
  if (!line) {
    return { name: 'MCP registered with Claude Code', status: 'warn', detail: 'not registered — run `designer setup` or see README' };
  }
  return { name: 'MCP registered with Claude Code', status: 'ok', detail: line.trim() };
}

async function readPromptArg(flags: Flags): Promise<string> {
  if (flags['prompt-file']) {
    const p = flags['prompt-file'] as string;
    return fs.readFileSync(p, 'utf8').trim();
  }
  const positional = (flags._ as string[]).join(' ').trim();
  if (positional === '-') {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk.toString());
    return chunks.join('').trim();
  }
  return positional;
}

function prettyName(filename: string): string {
  return filename
    .replace(/\.html$/i, '')
    .replace(/^(?:v\d+-|Philemon\s*[—-]\s*|.*?\s-\s)/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || filename;
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
