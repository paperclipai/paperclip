#!/usr/bin/env -S node --import tsx
// LLM-in-the-loop selector recovery. Triggered by `.github/workflows/auto-heal.yml`
// on daily-health failure. Two subcommands:
//
//   auto-heal triage
//     - Reads the latest artifact JSON. Bails on infra failures
//       (reason === 'cdp-unreachable'). Reads streak.json and picks one
//       eligible candidate (streak >= 2, AST-patchable, not in 7-day cooldown).
//       If >= 5 anchors regressed at once, comments wholesale-redesign on the
//       drift PR and bails. Emits step outputs telling the workflow whether
//       to proceed.
//
//   auto-heal heal <anchor-id>
//     - Reads the anchor block + HTML snapshot + screenshot. Calls
//       Anthropic API (claude-opus-4-7, tool-use). Bails on low confidence
//       or brittle selectors. Patches ui-anchors.ts. Re-runs the local
//       probe. If the patched anchor flips to ok, emits the step outputs
//       the workflow uses to open a PR. Otherwise reverts the patch.
//
// All failure modes exit 0 — auto-heal is best-effort. The drift PR opened
// by daily-health stays as the human-readable diagnostic regardless.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { REPO_ROOT } from '../repo-root.ts';
import { createBrowser } from '../browser.ts';
import { canPatch, findAnchor, patchSelector } from './anchor-patcher.ts';

const HEALTH_DIR = path.join(REPO_ROOT, 'artifacts', 'health');
const STREAK_PATH = path.join(HEALTH_DIR, 'streak.json');
const ANCHORS_PATH = path.join(REPO_ROOT, 'ui-anchors.ts');
const STREAK_THRESHOLD = 2;
const WHOLESALE_THRESHOLD = 5;
const COOLDOWN_DAYS = 7;
const CONFIDENCE_THRESHOLD = 0.7;
const ANTHROPIC_MODEL = 'claude-opus-4-7';

// Navigation targets for the fresh snapshot auto-heal captures on the runner
// (daily-health no longer uploads page.html/page.png — see captureCurrentSnapshot).
const HOME_URL = 'https://claude.ai/design';
const HOME_READY_SEL = '[data-testid="project-creator"]';
const SESSION_READY_SEL = '[data-testid="chat-composer-input"]';
const HTML_CAP_BYTES = 60_000;

// Priority: session anchors regressing breaks the canary loop hardest, so
// heal them first. Pattern anchors are URL-shape — usually low-yield to
// auto-heal but possible. Home last because home regressions don't block
// session-state probing.
const PRIORITY: Array<'session' | 'home' | 'pattern' | 'share'> = [
  'session',
  'share',
  'home',
  'pattern'
];

interface ProbeResult {
  id: string;
  category: 'home' | 'session' | 'share' | 'pattern';
  description: string;
  requires: 'home' | 'session' | 'any';
  status: 'ok' | 'fail' | 'skip';
  detail?: string;
  phase?: 'home' | 'session';
}

interface ArtifactJson {
  ok: boolean;
  reason?: string;
  health?: {
    ok: boolean;
    counts: { ok: number; fail: number; skip: number };
    results: ProbeResult[];
  };
  diagnostics?: { url: string; htmlBytes: number; screenshotPath?: string } | null;
  canary?: { target: string; landedOn: string; error?: string } | null;
  homeNav?: { target: string; landedOn: string; error?: string } | null;
}

interface ProposeSelectorInput {
  newSelector: string;
  confidence: number;
  rationale: string;
}

function ghOutput(key: string, value: string): void {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) {
    console.log(`[auto-heal] (no GITHUB_OUTPUT) ${key}=${value}`);
    return;
  }
  // Multi-line values need heredoc form. Single-line use key=value.
  if (value.includes('\n')) {
    const delim = `EOF_${Math.random().toString(36).slice(2, 10)}`;
    fs.appendFileSync(target, `${key}<<${delim}\n${value}\n${delim}\n`);
  } else {
    fs.appendFileSync(target, `${key}=${value}\n`);
  }
}

function latestArtifact(): { path: string; date: string; data: ArtifactJson } | null {
  if (!fs.existsSync(HEALTH_DIR)) return null;
  const entries = fs
    .readdirSync(HEALTH_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  for (const name of entries) {
    const p = path.join(HEALTH_DIR, name);
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8')) as ArtifactJson;
      return { path: p, date: name.replace(/\.json$/, ''), data };
    } catch {
      continue;
    }
  }
  return null;
}

function loadStreak(): Record<string, number> {
  if (!fs.existsSync(STREAK_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(STREAK_PATH, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function gh(args: string[], opts: { quiet?: boolean } = {}): string {
  const r = spawnSync('gh', args, { encoding: 'utf8', env: process.env });
  if (r.status !== 0) {
    if (!opts.quiet) console.log(`[auto-heal] gh ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
    return '';
  }
  return r.stdout;
}

function isWithinCooldown(anchorId: string): boolean {
  // Search for any auto-heal PR (open or closed) tagged with this anchor id
  // in the title within the cooldown window. `gh pr list --search` accepts
  // GitHub search syntax — restrict to PRs whose title contains the id.
  const out = gh([
    'pr',
    'list',
    '--label',
    'auto-heal',
    '--state',
    'all',
    '--search',
    `auto-heal ${anchorId} in:title`,
    '--json',
    'createdAt',
    '--limit',
    '5'
  ]);
  if (!out.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const cutoff = Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const createdAt = (item as { createdAt?: unknown }).createdAt;
    if (typeof createdAt !== 'string') continue;
    if (Date.parse(createdAt) >= cutoff) return true;
  }
  return false;
}

function findDriftPrNumber(date: string): number | null {
  const out = gh([
    'pr',
    'list',
    '--label',
    'selectors-drift',
    '--state',
    'open',
    '--search',
    `head:health/drift-${date}`,
    '--json',
    'number,headRefName',
    '--limit',
    '5'
  ]);
  if (!out.trim()) return null;
  try {
    const arr = JSON.parse(out) as Array<{ number: number; headRefName: string }>;
    const match = arr.find((p) => p.headRefName === `health/drift-${date}`);
    return match ? match.number : null;
  } catch {
    return null;
  }
}

// ---- triage ----

function triage(): void {
  // Exit-code discipline: genuine infra/contract failures (the artifact the
  // download step provided is missing or malformed) exit 1 so the workflow
  // goes red — they are NOT the same as an expected "nothing to heal" skip.
  // Expected skips (below-threshold, cooldown, wholesale-redesign,
  // cdp-unreachable) exit 0.
  const artifact = latestArtifact();
  if (!artifact) {
    console.log('[auto-heal triage] no artifact found — download step should have provided one');
    ghOutput('action', 'skip');
    ghOutput('reason', 'no-artifact');
    process.exit(1);
  }
  const { data, date } = artifact;
  ghOutput('date', date);

  if (data.reason === 'cdp-unreachable') {
    console.log('[auto-heal triage] artifact reason=cdp-unreachable — infra failure, skipping');
    ghOutput('action', 'skip');
    ghOutput('reason', 'cdp-unreachable');
    return;
  }

  if (!data.health || !Array.isArray(data.health.results)) {
    console.log('[auto-heal triage] artifact has no health.results — malformed');
    ghOutput('action', 'skip');
    ghOutput('reason', 'no-results');
    process.exit(1);
  }

  const streak = loadStreak();
  // A candidate must be BOTH at streak >= threshold AND currently failing in
  // this run's artifact. Without the current-fail cross-check, a stale streak
  // entry (anchor that recovered but whose streak wasn't reset because it
  // went 'skip') could trigger a heal that immediately no-ops — or worse,
  // inflate the count past WHOLESALE_THRESHOLD and cause a false wholesale bail.
  const failingNow = new Set(
    data.health.results.filter((r) => r.status === 'fail').map((r) => r.id)
  );
  const candidates = Object.entries(streak)
    .filter(([id, n]) => n >= STREAK_THRESHOLD && failingNow.has(id))
    .map(([id]) => id);

  if (candidates.length === 0) {
    console.log(`[auto-heal triage] no anchors at streak >= ${STREAK_THRESHOLD}`);
    ghOutput('action', 'skip');
    ghOutput('reason', 'below-threshold');
    return;
  }

  if (candidates.length >= WHOLESALE_THRESHOLD) {
    console.log(`[auto-heal triage] ${candidates.length} anchors regressed — wholesale-redesign suspected`);
    const driftPr = findDriftPrNumber(date);
    if (driftPr != null) {
      const body = [
        '## Wholesale redesign suspected',
        '',
        `${candidates.length} UI anchors have failed for ${STREAK_THRESHOLD}+ consecutive runs:`,
        '',
        ...candidates.map((id) => `- \`${id}\` (streak=${streak[id]})`),
        '',
        'Auto-heal **is not** opening single-anchor PRs for this — the failure pattern looks like a coordinated redesign on claude.ai/design, not isolated selector drift. A human should inspect the full snapshot before deciding which anchors to update.',
        '',
        `Labelled \`wholesale-redesign-suspected\` to flag in triage.`
      ].join('\n');
      gh(['pr', 'comment', String(driftPr), '--body', body]);
      gh(['pr', 'edit', String(driftPr), '--add-label', 'wholesale-redesign-suspected']);
    } else {
      console.log('[auto-heal triage] no drift PR found for this date — wholesale message skipped');
    }
    ghOutput('action', 'skip');
    ghOutput('reason', 'wholesale-redesign');
    ghOutput('candidate-count', String(candidates.length));
    return;
  }

  // Map id → category for priority sort
  const byId = new Map<string, ProbeResult>();
  for (const r of data.health.results) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }

  // Sort candidates by priority bucket
  const sorted = [...candidates].sort((a, b) => {
    const ca = byId.get(a)?.category ?? 'pattern';
    const cb = byId.get(b)?.category ?? 'pattern';
    return PRIORITY.indexOf(ca) - PRIORITY.indexOf(cb);
  });

  const anchorsSource = fs.readFileSync(ANCHORS_PATH, 'utf8');

  for (const id of sorted) {
    if (!canPatch(anchorsSource, id)) {
      console.log(`[auto-heal triage] ${id} — check shape not auto-patchable, skipping`);
      continue;
    }
    if (isWithinCooldown(id)) {
      console.log(`[auto-heal triage] ${id} — within ${COOLDOWN_DAYS}-day cooldown, skipping`);
      continue;
    }
    console.log(`[auto-heal triage] selected ${id} (streak=${streak[id]}, category=${byId.get(id)?.category ?? 'unknown'})`);
    ghOutput('action', 'heal');
    ghOutput('anchor-id', id);
    return;
  }

  console.log('[auto-heal triage] all candidates either complex or in cooldown — skipping');
  ghOutput('action', 'skip');
  ghOutput('reason', 'no-eligible-candidate');
}

// ---- heal ----

function isBrittleSelector(sel: string): boolean {
  // Pure structural CSS paths are too brittle to land via auto-heal. Reject
  // selectors that lean on nth-child / nth-of-type — they're position-bound
  // and break on tiny DOM tweaks. data-testid / role / aria-* / text-content
  // markers are preferred and pass this filter.
  if (/:nth-child\(|:nth-of-type\(/i.test(sel)) return true;
  // No identifying attribute at all — pure tag+combinator path.
  if (
    !/\[/.test(sel) &&
    !/data-testid/i.test(sel) &&
    !/role=/i.test(sel) &&
    !/aria-/i.test(sel) &&
    !/#[\w-]/.test(sel) &&
    !/\./.test(sel)
  ) {
    return true;
  }
  return false;
}

function capHtml(raw: string): string {
  // Cap at ~60KB — the prompt budget is finite and most of <head> is style/font
  // boilerplate. The anchor selector inference cares about the rendered tree
  // around testids, role attrs, button text — usually <body>'s first ~60KB.
  if (raw.length <= HTML_CAP_BYTES) return raw;
  const bodyStart = raw.search(/<body[\s>]/i);
  if (bodyStart > 0) return raw.slice(bodyStart, bodyStart + HTML_CAP_BYTES);
  return raw.slice(0, HTML_CAP_BYTES);
}

async function captureCurrentSnapshot(
  phase: 'home' | 'session'
): Promise<{ html: string; screenshotBase64: string | null }> {
  // daily-health no longer uploads page.html / page.png — this is a public
  // repo and those are raw DOM + screenshots of a signed-in claude.ai
  // session (the home phase's DOM includes the user's real project list).
  // auto-heal runs on the same self-hosted runner with the live CDP Chrome,
  // so it captures its own snapshot fresh. Bonus: this is the *current* DOM,
  // which is the right input for selector inference anyway (the heal
  // re-probes against live state regardless).
  const target = phase === 'home' ? HOME_URL : process.env.DESIGNER_PROBE_PROJECT_URL;
  const readySel = phase === 'home' ? HOME_READY_SEL : SESSION_READY_SEL;
  if (!target) {
    console.log(`[auto-heal heal] no navigation target for phase=${phase} — proceeding without snapshot`);
    return { html: '', screenshotBase64: null };
  }
  const browser = createBrowser({ session: 'designer-default', timeoutMs: 15_000 });
  try {
    await browser.open(target);
    await browser.waitFor(readySel).catch(() => undefined);
    const rawHtml = await browser
      .evalValue<string>('document.documentElement.outerHTML')
      .catch(() => '');
    const shotPath = path.join(os.tmpdir(), `auto-heal-snapshot-${Date.now()}.png`);
    await browser.screenshot(shotPath, { full: true }).catch(() => null);
    let screenshotBase64: string | null = null;
    if (fs.existsSync(shotPath)) {
      screenshotBase64 = fs.readFileSync(shotPath).toString('base64');
      fs.rmSync(shotPath, { force: true });
    }
    return { html: capHtml(typeof rawHtml === 'string' ? rawHtml : ''), screenshotBase64 };
  } catch (e) {
    console.log(`[auto-heal heal] snapshot capture failed: ${(e as Error).message}`);
    return { html: '', screenshotBase64: null };
  }
}

async function heal(anchorId: string): Promise<void> {
  // Two auth paths: API key (x-api-key header, metered per-token billing) OR
  // OAuth token via Claude Pro/Max subscription (Bearer header, subscription
  // quota). CLAUDE_CODE_OAUTH_TOKEN is the secret name the official Claude
  // Code Action installs; pass it as authToken to the SDK. The SDK supports
  // both via separate constructor options — apiKey wins if both are set.
  const apiKey = process.env.ANTHROPIC_API_KEY ?? undefined;
  const authToken =
    process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? undefined;
  // Exit-code discipline (mirrors triage): infra/auth/contract failures
  // exit 1 so the workflow goes red. A silently-caught auth 401 turning
  // into a green no-op is exactly the failure class this guards against.
  // Expected non-heal outcomes (not-failing, low-confidence, brittle-
  // selector, re-probe-still-failing, ...) stay exit 0.
  if (!apiKey && !authToken) {
    console.error(
      '[auto-heal heal] no Anthropic credential (need ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) — automation unavailable'
    );
    ghOutput('patched', 'false');
    ghOutput('reason', 'no-credential');
    process.exit(1);
  }

  const artifact = latestArtifact();
  if (!artifact) {
    console.error('[auto-heal heal] no artifact — download step should have provided one');
    ghOutput('patched', 'false');
    ghOutput('reason', 'no-artifact');
    process.exit(1);
  }
  const { date, data } = artifact;

  const failed = data.health?.results.find((r) => r.id === anchorId && r.status === 'fail');
  if (!failed) {
    console.log(`[auto-heal heal] ${anchorId} not in failed-results — nothing to heal`);
    ghOutput('patched', 'false');
    ghOutput('reason', 'not-failing');
    return;
  }

  const anchorsSource = fs.readFileSync(ANCHORS_PATH, 'utf8');
  const match = findAnchor(anchorsSource, anchorId);
  if (!match) {
    console.log(`[auto-heal heal] ${anchorId} not patchable`);
    ghOutput('patched', 'false');
    ghOutput('reason', 'not-patchable');
    return;
  }

  const anchor = data.health?.results.find((r) => r.id === anchorId);
  const phaseHint = failed.phase ?? anchor?.requires ?? 'unknown';

  // Capture a fresh snapshot on the runner (daily-health no longer uploads
  // page.html/page.png). Navigate to the phase the anchor failed in; for
  // `any`-state anchors with no phase tag, default to the session page.
  const snapshotPhase: 'home' | 'session' =
    failed.phase ?? (failed.requires === 'home' ? 'home' : 'session');
  const { html, screenshotBase64: screenshot } = await captureCurrentSnapshot(snapshotPhase);

  const promptText = [
    `# Failed UI anchor`,
    ``,
    `**Anchor id:** \`${anchorId}\``,
    `**Description:** ${anchor?.description ?? '(unknown)'}`,
    `**Required state:** ${anchor?.requires ?? '(unknown)'}`,
    `**Phase observed:** ${phaseHint}`,
    `**Current selector:** \`${match.currentSelector}\``,
    `**Failure detail:** ${failed.detail ?? '(no detail)'}`,
    ``,
    `# Anchor block (from ui-anchors.ts)`,
    '```typescript',
    anchorSourceBlock(anchorsSource, anchorId),
    '```',
    ``,
    `# Page HTML (captured when probe failed${html.length === 60_000 ? '; truncated to 60KB' : ''})`,
    '```html',
    html.slice(0, 60_000),
    '```',
    ``,
    `# Task`,
    `Propose a single new CSS selector that finds the same UI element the`,
    `original selector targeted before the regression. The selector will replace`,
    `the string literal inside \`hasSelector(b, '...')\` in the anchor block above.`,
    ``,
    `Selector preferences (strict): \`data-testid\` > \`role\` > \`aria-*\` > stable id > stable class.`,
    `Reject pure structural paths (\`div > div:nth-child(N)\`) — too brittle.`,
    `If the right element clearly does not exist in the snapshot, return confidence < 0.5.`
  ].join('\n');

  const tool: Anthropic.Tool = {
    name: 'propose_selector',
    description: 'Propose a CSS selector to replace the failed UI anchor.',
    input_schema: {
      type: 'object',
      properties: {
        newSelector: {
          type: 'string',
          description: 'CSS selector for the replacement DOM element (single string, no quotes).'
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '0..1. Below 0.7 will be rejected by the caller.'
        },
        rationale: {
          type: 'string',
          description: 'Why this selector matches the anchor description — what DOM evidence supports it.'
        }
      },
      required: ['newSelector', 'confidence', 'rationale']
    }
  };

  const client = new Anthropic({ apiKey, authToken });
  const userContent: Anthropic.MessageParam['content'] = [{ type: 'text', text: promptText }];
  if (screenshot) {
    userContent.unshift({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: screenshot }
    });
  }

  console.log(`[auto-heal heal] calling ${ANTHROPIC_MODEL} for ${anchorId}`);
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 2048,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'propose_selector' },
      system:
        'You are a UI-anchor selector recovery agent for claude.ai/design. Given a failed UI anchor and the page HTML + screenshot at the moment of failure, propose a single replacement CSS selector. Prefer stable test markers (data-testid, role, aria-*) over structural paths.',
      messages: [{ role: 'user', content: userContent }]
    });
  } catch (e) {
    // Includes a 401 if CLAUDE_CODE_OAUTH_TOKEN turns out not to authenticate
    // raw /v1/messages calls — that's "automation broken", not "nothing to do".
    console.error(`[auto-heal heal] Anthropic API error: ${(e as Error).message}`);
    ghOutput('patched', 'false');
    ghOutput('reason', 'api-error');
    process.exit(1);
  }

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) {
    console.error(`[auto-heal heal] model did not call the propose_selector tool — prompt/contract drift`);
    ghOutput('patched', 'false');
    ghOutput('reason', 'no-tool-call');
    process.exit(1);
  }
  const input = toolUse.input as Partial<ProposeSelectorInput>;
  if (
    typeof input.newSelector !== 'string' ||
    typeof input.confidence !== 'number' ||
    typeof input.rationale !== 'string'
  ) {
    console.error(`[auto-heal heal] propose_selector input malformed: ${JSON.stringify(input)}`);
    ghOutput('patched', 'false');
    ghOutput('reason', 'malformed-tool-input');
    process.exit(1);
  }

  const { newSelector, confidence, rationale } = input as ProposeSelectorInput;
  console.log(`[auto-heal heal] proposal: confidence=${confidence}, selector=${newSelector}`);
  console.log(`[auto-heal heal] rationale: ${rationale}`);

  if (confidence < CONFIDENCE_THRESHOLD) {
    console.log(`[auto-heal heal] confidence ${confidence} below threshold ${CONFIDENCE_THRESHOLD} — bailing`);
    ghOutput('patched', 'false');
    ghOutput('reason', 'low-confidence');
    ghOutput('confidence', String(confidence));
    return;
  }
  if (isBrittleSelector(newSelector)) {
    console.log(`[auto-heal heal] selector "${newSelector}" looks brittle — bailing`);
    ghOutput('patched', 'false');
    ghOutput('reason', 'brittle-selector');
    return;
  }
  if (newSelector === match.currentSelector) {
    console.log(`[auto-heal heal] proposed selector identical to current — no-op`);
    ghOutput('patched', 'false');
    ghOutput('reason', 'identical-selector');
    return;
  }

  // Apply the patch.
  const patched = patchSelector(anchorsSource, anchorId, newSelector);
  fs.writeFileSync(ANCHORS_PATH, patched);
  console.log(`[auto-heal heal] patched ui-anchors.ts: ${match.currentSelector} -> ${newSelector}`);

  // Re-probe locally.
  console.log(`[auto-heal heal] re-running probe...`);
  const probe = spawnSync('npm', ['run', '-s', 'probe:health'], {
    encoding: 'utf8',
    env: process.env,
    stdio: 'inherit'
  });
  console.log(`[auto-heal heal] probe exit code: ${probe.status}`);

  // Positive-confirmation invariant: we only emit patched=true when the
  // re-probe contains the patched anchor AND every entry for it is `ok`.
  // The naive `.some(status === 'fail')` check is false-positive on three
  // shapes the re-probe can produce: (1) cdp-unreachable artifact has no
  // `health` field; (2) probe wrote no `health.results`; (3) anchor was
  // filtered out by phase mismatch and never actually probed. Each of
  // those means "we don't know if the patch worked" — so revert, don't
  // claim victory.
  const reArtifact = latestArtifact();
  if (!reArtifact) {
    console.error(`[auto-heal heal] re-probe produced no artifact — reverting (infra failure)`);
    revertAnchors();
    ghOutput('patched', 'false');
    ghOutput('reason', 're-probe-no-artifact');
    process.exit(1);
  }
  if (reArtifact.data.reason === 'cdp-unreachable') {
    console.error(`[auto-heal heal] re-probe hit cdp-unreachable — cannot verify, reverting (infra failure)`);
    revertAnchors();
    ghOutput('patched', 'false');
    ghOutput('reason', 're-probe-cdp-unreachable');
    process.exit(1);
  }
  const reResults = reArtifact.data.health?.results;
  if (!Array.isArray(reResults) || reResults.length === 0) {
    console.error(`[auto-heal heal] re-probe artifact has no health.results — reverting (malformed)`);
    revertAnchors();
    ghOutput('patched', 'false');
    ghOutput('reason', 're-probe-no-results');
    process.exit(1);
  }
  const entriesForAnchor = reResults.filter((r) => r.id === anchorId);
  if (entriesForAnchor.length === 0) {
    console.log(`[auto-heal heal] re-probe did not probe ${anchorId} (phase mismatch?) — reverting`);
    revertAnchors();
    ghOutput('patched', 'false');
    ghOutput('reason', 're-probe-anchor-missing');
    return;
  }
  const nonOk = entriesForAnchor.filter((r) => r.status !== 'ok');
  if (nonOk.length > 0) {
    console.log(
      `[auto-heal heal] re-probe shows ${anchorId} still failing in ${nonOk.length}/${entriesForAnchor.length} phase(s) — reverting`
    );
    revertAnchors();
    ghOutput('patched', 'false');
    ghOutput('reason', 're-probe-still-failing');
    return;
  }

  console.log(
    `[auto-heal heal] re-probe green for ${anchorId} in ${entriesForAnchor.length} phase(s) — emitting step outputs`
  );
  const driftPr = findDriftPrNumber(date);
  ghOutput('patched', 'true');
  ghOutput('anchor-id', anchorId);
  ghOutput('old-selector', match.currentSelector);
  ghOutput('new-selector', newSelector);
  ghOutput('confidence', String(confidence));
  ghOutput('rationale', rationale);
  ghOutput('drift-pr-number', driftPr != null ? String(driftPr) : '');
  ghOutput('date', date);
}

function revertAnchors(): void {
  try {
    execSync(`git checkout -- ${path.relative(REPO_ROOT, ANCHORS_PATH)}`, {
      cwd: REPO_ROOT,
      stdio: 'inherit'
    });
  } catch (e) {
    console.log(`[auto-heal heal] revert failed: ${(e as Error).message}`);
  }
}

function anchorSourceBlock(source: string, id: string): string {
  // Best-effort: scan line-by-line for `id: '<id>'` and return the surrounding
  // 5 lines before / 25 after. Cheaper than re-walking the AST for a slice.
  const lines = source.split('\n');
  const needle = new RegExp(`id:\\s*['"\`]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && needle.test(line)) {
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length, i + 25);
      return lines.slice(start, end).join('\n');
    }
  }
  return '(anchor block not located in source)';
}

// ---- entry ----

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'triage') {
    triage();
  } else if (cmd === 'heal') {
    const id = process.argv[3];
    if (!id) {
      console.error('Usage: auto-heal heal <anchor-id>');
      process.exit(2);
    }
    await heal(id);
  } else {
    console.error('Usage: auto-heal triage | heal <anchor-id>');
    process.exit(2);
  }
}

main().catch((e: Error) => {
  // An uncaught exception is a programmer error (bad artifact shape, missing
  // tool, SDK contract drift). Exit 1 so the workflow goes red — masking it
  // as exit 0 would put it in the same silent-no-op class the expected-skip
  // paths are carefully kept out of. Expected non-heal outcomes never reach
  // here; they emit their `reason` and return/exit explicitly.
  console.error(`[auto-heal] threw: ${e.stack || e.message}`);
  process.exit(1);
});
