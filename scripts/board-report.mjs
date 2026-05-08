#!/usr/bin/env node
// board-report: fetch Paperclip issues, write open-slide data, deliver email + notification.
// Usage: node scripts/board-report.mjs --slot=1150|1650 [--force] [--dry-run]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Source notifier env file before const declarations so PAPERCLIP_API_KEY and
// RESEND_API_KEY are available regardless of how the script is invoked (launchd,
// cron, or direct shell). Only fills missing keys — never overwrites existing env.
{ const _f = '/Users/jlqueguiner/.paperclip-worktrees/instances/paperclip-openrunner/secrets/notifier.env';
  if (existsSync(_f)) { for (const _l of readFileSync(_f, 'utf8').split('\n')) { const _m = _l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (_m && !process.env[_m[1]]) process.env[_m[1]] = _m[2]; } } }

// ─── Constants ────────────────────────────────────────────────────────────────
const COMPANY_ID = '050de589-23d3-40bb-b227-efea13164d01';
const FAILURE_ISSUE = process.env.BOARD_REPORT_FAILURE_ISSUE_ID || 'GLA-77';
const SLIDE_ID = 'board-report';
const SLIDE_DIR = '/Users/jlqueguiner/open-slide/slides/board-report';
const STATE_DIR = join(homedir(), '.local', 'state', 'openrunner-board-report');
const STATE_FILE = join(STATE_DIR, 'state.json');
const DECK_URL = process.env.OPENRUNNER_BOARD_REPORT_URL || `http://localhost:5173/s/${SLIDE_ID}`;
const PAPERCLIP_URL = process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3101';
const PAPERCLIP_TOKEN = process.env.PAPERCLIP_API_KEY || '';
const PAPERCLIP_RUN_ID = process.env.PAPERCLIP_RUN_ID || '';
const RECIPIENT = process.env.BOARD_REPORT_RECIPIENT || 'jl@gladia.io';
const SENDER = process.env.BOARD_REPORT_FROM || 'jlqueguiner@gladia.io';
const COMPANY_SHORTNAME = process.env.PAPERCLIP_COMPANY_SHORTNAME || 'GLA';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFIER_ENV_FILE = '/Users/jlqueguiner/.paperclip-worktrees/instances/paperclip-openrunner/secrets/notifier.env';
const ASSET_LIBRARY_URL = (process.env.ASSET_LIBRARY_URL || 'http://127.0.0.1:7700').replace(/\/$/, '');
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const TOP_TODO = 8;
const TOP_DONE = 15;
const TOP_IN_PROGRESS = 10;
const TOP_BLOCKERS = 12;
const COMMENT_DIGEST_MAX = 220;
const SLOT_LABELS = { '1150': '11:50', '1650': '16:50' };

// Auto-source the notifier env file if RESEND_API_KEY isn't already set.
if (!RESEND_API_KEY && existsSync(NOTIFIER_ENV_FILE)) {
  for (const line of readFileSync(NOTIFIER_ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ─── CLI parse ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { slot: null, force: false, dryRun: false };
  for (const a of argv) {
    if (a.startsWith('--slot=')) out.slot = a.slice(7);
    else if (a === '--force') out.force = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/board-report.mjs --slot=1150|1650 [--force] [--dry-run]');
      process.exit(0);
    }
  }
  if (!out.slot || !SLOT_LABELS[out.slot]) {
    console.error('Error: --slot=1150 or --slot=1650 is required.');
    process.exit(2);
  }
  return out;
}

// ─── State ────────────────────────────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return { lastRunSlot: '', lastRunAt: '', lastDoneCursor: '' };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRunSlot: '', lastRunAt: '', lastDoneCursor: '' };
  }
}

function writeAtomic(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

function saveState(state) {
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ─── Paperclip API ────────────────────────────────────────────────────────────
async function papGet(path) {
  const res = await fetch(`${PAPERCLIP_URL}${path}`, {
    headers: { Authorization: `Bearer ${PAPERCLIP_TOKEN}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function papPost(path, body) {
  const res = await fetch(`${PAPERCLIP_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAPERCLIP_TOKEN}`,
      'X-Paperclip-Run-Id': PAPERCLIP_RUN_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function papPatch(path, body) {
  const res = await fetch(`${PAPERCLIP_URL}${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${PAPERCLIP_TOKEN}`,
      'X-Paperclip-Run-Id': PAPERCLIP_RUN_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

// ─── Bucketing ────────────────────────────────────────────────────────────────
function shapeIssue(i) {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    priority: i.priority || 'medium',
    status: i.status,
    completedAt: i.completedAt || null,
    updatedAt: i.updatedAt || null,
    assigneeAgentName: null,
    blockerAttention: i.blockerAttention || null,
  };
}

function bucketize(issues, cursorIso) {
  const cursor = cursorIso ? Date.parse(cursorIso) : 0;
  const done = [];
  const inProgress = [];
  const upNext = [];
  const blockers = [];

  for (const raw of issues) {
    if (raw.hiddenAt) continue;
    const i = shapeIssue(raw);
    if (i.status === 'done') {
      const t = i.completedAt ? Date.parse(i.completedAt) : 0;
      if (t > cursor) done.push(i);
    } else if (i.status === 'in_progress' || i.status === 'in_review') {
      inProgress.push(i);
    } else if (i.status === 'todo') {
      upNext.push(i);
    } else if (i.status === 'blocked') {
      blockers.push(i);
    }
  }

  const byPriThenUpdated = (a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 9;
    const pb = PRIORITY_RANK[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  };

  done.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  inProgress.sort(byPriThenUpdated);
  upNext.sort(byPriThenUpdated);
  blockers.sort(byPriThenUpdated);

  return {
    done: done.slice(0, TOP_DONE),
    inProgress: inProgress.slice(0, TOP_IN_PROGRESS),
    upNext: upNext.slice(0, TOP_TODO),
    blockers: blockers.slice(0, TOP_BLOCKERS),
  };
}

// ─── Enrichment (last comment, deliverables, decisions) ───────────────────────
async function fetchLastCommentDigest(issueUuid) {
  try {
    const comments = await papGet(`/api/issues/${issueUuid}/comments?limit=1&order=desc`);
    const list = Array.isArray(comments) ? comments : (comments?.data ?? []);
    if (list.length === 0) return null;
    // API may not honor order=desc; pick latest by createdAt to be safe.
    const latest = list.reduce((acc, c) =>
      (!acc || (c.createdAt || '').localeCompare(acc.createdAt || '') > 0) ? c : acc
    , null);
    if (!latest?.body) return null;
    const oneLine = latest.body.replace(/\s+/g, ' ').trim();
    return {
      excerpt: oneLine.length > COMMENT_DIGEST_MAX ? oneLine.slice(0, COMMENT_DIGEST_MAX - 1) + '…' : oneLine,
      createdAt: latest.createdAt,
    };
  } catch {
    return null;
  }
}

async function fetchDocuments(issueUuid) {
  try {
    const docs = await papGet(`/api/issues/${issueUuid}/documents`);
    const list = Array.isArray(docs) ? docs : (docs?.data ?? []);
    return list.map((d) => d.key || d.name || d.id).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchOpenDecisions(issueUuid) {
  try {
    const inter = await papGet(`/api/issues/${issueUuid}/interactions`);
    const list = Array.isArray(inter) ? inter : (inter?.data ?? []);
    return list.filter((i) =>
      (i.kind === 'ask_user_questions' || i.kind === 'request_confirmation') &&
      (i.state === 'open' || i.state === 'pending' || !i.resolvedAt)
    );
  } catch {
    return [];
  }
}

async function enrichIssue(issue, { withDocs, withDecisions } = {}) {
  const [last, docs, decisions] = await Promise.all([
    fetchLastCommentDigest(issue.id),
    withDocs ? fetchDocuments(issue.id) : Promise.resolve([]),
    withDecisions ? fetchOpenDecisions(issue.id) : Promise.resolve([]),
  ]);
  return { ...issue, lastComment: last, documents: docs, decisions };
}

async function enrichBuckets(buckets) {
  // Run all enrichments in parallel for snappier email build.
  const [done, inProgress, upNext, blockers] = await Promise.all([
    Promise.all(buckets.done.map((i) => enrichIssue(i, { withDocs: true }))),
    Promise.all(buckets.inProgress.map((i) => enrichIssue(i, { withDocs: true }))),
    Promise.all(buckets.upNext.map((i) => enrichIssue(i))),
    Promise.all(buckets.blockers.map((i) => enrichIssue(i, { withDocs: true, withDecisions: true }))),
  ]);
  return { done, inProgress, upNext, blockers };
}

// ─── Smoke check ──────────────────────────────────────────────────────────────
async function smokeDeck() {
  let res;
  try {
    res = await fetch(DECK_URL, { method: 'GET' });
  } catch (err) {
    throw new Error(`open-slide dev server unreachable at ${DECK_URL}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`open-slide dev server returned HTTP ${res.status} at ${DECK_URL}`);
  }
}

// ─── Delivery ─────────────────────────────────────────────────────────────────
function escapeAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function issueDashboardUrl(identifier) {
  return `${PAPERCLIP_URL.replace(/\/$/, '')}/${COMPANY_SHORTNAME}/issues/${identifier}`;
}

const ASSET_REVIEW_TITLE_PREFIXES = ['[review-and-ship]', '[marketing-asset]'];

function isAssetReviewIssue(issue) {
  if (!issue) return false;
  const title = String(issue.title || '').trim().toLowerCase();
  return ASSET_REVIEW_TITLE_PREFIXES.some((p) => title.startsWith(p));
}

function assetCtaUrl(issueId, docKey) {
  if (docKey) return `${ASSET_LIBRARY_URL}/asset/${issueId}/${encodeURIComponent(docKey)}`;
  return `${ASSET_LIBRARY_URL}/asset/${issueId}`;
}

function decisionDashboardUrl(issueIdentifier, interactionId) {
  return `${issueDashboardUrl(issueIdentifier)}#interaction-${interactionId}`;
}

function buildEmailHtml({ buckets, counts, slotLabel, dateLabel, generatedAt, cursorFromIso }) {
  const issueLi = (i, opts = {}) => {
    const url = issueDashboardUrl(i.identifier);
    const isAsset = isAssetReviewIssue(i);
    const pri = i.priority && i.priority !== 'medium'
      ? ` <span style="color:#a00;font-size:11px;">[${escapeHtml(i.priority)}]</span>`
      : '';
    const headlineUrl = isAsset
      ? (i.documents && i.documents.length > 0 ? assetCtaUrl(i.id, i.documents[0]) : assetCtaUrl(i.id, null))
      : url;
    const tag = isAsset ? ' <span style="color:#7a3;font-size:11px;">[asset-review]</span>' : '';
    const lines = [
      `<a href="${headlineUrl}" style="color:#06c;font-weight:600;text-decoration:none;">${escapeHtml(i.identifier)}</a>${pri}${tag} — ${escapeHtml(i.title)}`,
    ];
    if (isAsset && i.documents && i.documents.length > 0) {
      const ctaLinks = i.documents.map((k) =>
        `<a href="${escapeHtml(assetCtaUrl(i.id, k))}" style="color:#06c;text-decoration:none;">▶ ${escapeHtml(k)}</a>`
      ).join(' · ');
      lines.push(`<div style="font-size:12px;margin:2px 0 0 0;">└ asset library: ${ctaLinks}</div>`);
      lines.push(`<div style="font-size:11px;color:#888;margin:2px 0 0 0;">└ <a href="${url}" style="color:#888;">issue thread →</a></div>`);
    }
    if (i.lastComment?.excerpt) {
      lines.push(`<div style="color:#666;font-size:12px;margin:2px 0 0 0;">└ ${escapeHtml(i.lastComment.excerpt)}</div>`);
    }
    if (opts.showDocs && !isAsset && i.documents && i.documents.length > 0) {
      lines.push(`<div style="color:#888;font-size:12px;margin:2px 0 0 0;">└ deliverables: ${i.documents.map(escapeHtml).join(', ')}</div>`);
    }
    if (opts.showDecisions && i.decisions && i.decisions.length > 0) {
      for (const d of i.decisions) {
        const decisionUrl = decisionDashboardUrl(i.identifier, d.id);
        const kindLabel = d.kind === 'request_confirmation' ? 'Confirmation needed' : 'Question';
        const ask = d.payload?.summary || d.payload?.title || d.payload?.question || d.payload?.body || '';
        lines.push(
          `<div style="color:#a00;font-size:12px;margin:4px 0 0 0;font-weight:600;">└ DECISION (${escapeHtml(kindLabel)}): ${escapeHtml(truncate(ask, 200))}</div>`,
          `<div style="font-size:12px;margin:0 0 0 12px;"><a href="${decisionUrl}" style="color:#06c;">→ Answer here</a></div>`,
        );
      }
    } else if (opts.showDecisions && i.blockerAttention?.state === 'needs_attention') {
      const sample = i.blockerAttention.sampleBlockerIdentifier;
      lines.push(
        `<div style="color:#a00;font-size:12px;margin:4px 0 0 0;font-weight:600;">└ BLOCKED — needs human: ${i.blockerAttention.unresolvedBlockerCount ?? '?'} unresolved blocker(s)${sample ? `, sample: ${escapeHtml(sample)}` : ''}</div>`,
        `<div style="font-size:12px;margin:0 0 0 12px;"><a href="${url}" style="color:#06c;">→ Review on dashboard</a></div>`,
      );
    }
    return `<li style="margin:6px 0;">${lines.join('')}</li>`;
  };

  const section = (heading, color, items, opts) => {
    if (items.length === 0) return '';
    return `
      <h3 style="color:${color};margin:18px 0 6px 0;font-size:14px;">${heading} (${items.length})</h3>
      <ul style="list-style:none;padding-left:0;margin:0;">
        ${items.map((i) => issueLi(i, opts)).join('')}
      </ul>`;
  };

  return `
<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222;max-width:700px;margin:0 auto;padding:16px;">
  <h2 style="margin:0 0 4px 0;">OpenRunner board report — ${escapeHtml(dateLabel)} ${escapeHtml(slotLabel)}</h2>
  <div style="color:#666;font-size:13px;margin-bottom:8px;">
    done <strong>${counts.done}</strong> · in_progress <strong>${counts.inProgress}</strong> · up_next <strong>${counts.upNext}</strong> · blockers <strong>${counts.blockers}</strong>
  </div>
  <div style="margin-bottom:12px;"><a href="${escapeHtml(DECK_URL)}" style="color:#06c;">Open full deck →</a></div>
  ${section('🛑 Blockers needing decision', '#a00', buckets.blockers, { showDocs: true, showDecisions: true })}
  ${section('🔵 In progress', '#06c', buckets.inProgress, { showDocs: true })}
  ${section('⏭ Up next', '#444', buckets.upNext, {})}
  ${section('🟢 Done since cursor', '#080', buckets.done, { showDocs: true })}
  <hr style="margin-top:24px;border:none;border-top:1px solid #eee;">
  <div style="color:#888;font-size:11px;margin-top:8px;">
    Generated ${escapeHtml(generatedAt)} · window since ${escapeHtml(cursorFromIso)}
  </div>
</body></html>`;
}

function buildEmailText({ buckets, counts, slotLabel, dateLabel, generatedAt, cursorFromIso }) {
  const issueLine = (i, opts = {}) => {
    const url = issueDashboardUrl(i.identifier);
    const isAsset = isAssetReviewIssue(i);
    const pri = i.priority && i.priority !== 'medium' ? ` [${i.priority}]` : '';
    const tag = isAsset ? ' [asset-review]' : '';
    const headlineUrl = isAsset
      ? (i.documents?.length > 0 ? assetCtaUrl(i.id, i.documents[0]) : assetCtaUrl(i.id, null))
      : url;
    const lines = [`${i.identifier}${pri}${tag} — ${i.title}`, `  ${headlineUrl}`];
    if (isAsset && i.documents?.length > 0) {
      for (const k of i.documents) lines.push(`  ▶ ${k}: ${assetCtaUrl(i.id, k)}`);
      lines.push(`  issue: ${url}`);
    }
    if (i.lastComment?.excerpt) lines.push(`  └ ${i.lastComment.excerpt}`);
    if (opts.showDocs && !isAsset && i.documents?.length > 0) lines.push(`  └ deliverables: ${i.documents.join(', ')}`);
    if (opts.showDecisions && i.decisions?.length > 0) {
      for (const d of i.decisions) {
        const ask = d.payload?.summary || d.payload?.title || d.payload?.question || '';
        lines.push(`  └ DECISION (${d.kind}): ${truncate(ask, 200)}`);
        lines.push(`    → ${decisionDashboardUrl(i.identifier, d.id)}`);
      }
    } else if (opts.showDecisions && i.blockerAttention?.state === 'needs_attention') {
      const s = i.blockerAttention;
      lines.push(`  └ BLOCKED — ${s.unresolvedBlockerCount ?? '?'} unresolved blocker(s)${s.sampleBlockerIdentifier ? `, sample: ${s.sampleBlockerIdentifier}` : ''}`);
      lines.push(`    → ${url}`);
    }
    return lines.join('\n');
  };
  const section = (heading, items, opts) =>
    items.length === 0 ? '' : `\n${heading} (${items.length})\n${'─'.repeat(40)}\n${items.map((i) => issueLine(i, opts)).join('\n\n')}`;
  return [
    `OpenRunner board report — ${dateLabel} ${slotLabel}`,
    `done ${counts.done} · in_progress ${counts.inProgress} · up_next ${counts.upNext} · blockers ${counts.blockers}`,
    `Deck: ${DECK_URL}`,
    section('BLOCKERS NEEDING DECISION', buckets.blockers, { showDocs: true, showDecisions: true }),
    section('IN PROGRESS', buckets.inProgress, { showDocs: true }),
    section('UP NEXT', buckets.upNext, {}),
    section('DONE SINCE CURSOR', buckets.done, { showDocs: true }),
    `\n\nGenerated ${generatedAt}.\nWindow since ${cursorFromIso}.`,
  ].filter(Boolean).join('\n');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function sendEmailViaResend({ subject, html, text }) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing — cannot send email.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: SENDER, to: [RECIPIENT], subject, html, text }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body)}`);
  return body?.id;
}

function sendEmailViaMailApp({ subject, body }) {
  const script = `
tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:"${escapeAppleScript(subject)}", content:"${escapeAppleScript(body)}", visible:false}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:"${escapeAppleScript(RECIPIENT)}"}
    send
  end tell
end tell
`;
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`osascript Mail send failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
}

async function sendEmail({ subject, html, text }) {
  if (process.env.RESEND_API_KEY) {
    const id = await sendEmailViaResend({ subject, html, text });
    console.log(`email sent via Resend (id=${id})`);
    return;
  }
  // Fallback to AppleScript Mail.app (text only).
  console.log('RESEND_API_KEY not set — falling back to Mail.app (text-only).');
  sendEmailViaMailApp({ subject, body: text });
}

function hasTerminalNotifier() {
  const r = spawnSync('/bin/sh', ['-c', 'command -v terminal-notifier'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

function fireNotification({ title, subtitle, message, openUrl }) {
  if (hasTerminalNotifier()) {
    const args = [
      '-title', title,
      '-subtitle', subtitle,
      '-message', message,
      '-open', openUrl,
    ];
    const r = spawnSync('terminal-notifier', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`terminal-notifier failed (exit ${r.status}): ${r.stderr}`);
    return;
  }
  const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" subtitle "${escapeAppleScript(subtitle)}"`;
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`osascript notification failed (exit ${r.status}): ${r.stderr}`);
}

// ─── Failure path ─────────────────────────────────────────────────────────────
async function reportFailure(slot, err) {
  const stack = (err.stack || String(err)).split('\n').slice(0, 18).join('\n');
  const body = [
    `# board-report run failed`,
    ``,
    `- slot: \`${slot}\``,
    `- when: \`${new Date().toISOString()}\``,
    `- host: \`${process.env.USER || 'unknown'}@${process.env.HOSTNAME || ''}\``,
    ``,
    '```',
    stack,
    '```',
  ].join('\n');
  // Targets in priority order. The executor issue (per-fire, set by routine framework)
  // is the always-permitted fallback when the routine runs as an agent that doesn't
  // own GLA-51. De-duplicated; null entries skipped.
  const executorIssue = process.env.PAPERCLIP_ISSUE_IDENTIFIER || '';
  const targets = [];
  for (const t of [FAILURE_ISSUE, executorIssue]) {
    if (t && !targets.includes(t)) targets.push(t);
  }
  const errors = [];
  let posted = false;
  for (const target of targets) {
    try {
      await papPatch(`/api/issues/${target}`, { comment: body });
      posted = true;
      break;
    } catch (patchErr) {
      errors.push(`PATCH ${target}: ${patchErr.message}`);
      try {
        await papPost(`/api/issues/${target}/comments`, { body });
        posted = true;
        break;
      } catch (postErr) {
        errors.push(`POST ${target}/comments: ${postErr.message}`);
      }
    }
  }
  if (!posted) {
    console.error('failure-path: all targets failed.');
    for (const e of errors) console.error(' ', e);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!PAPERCLIP_TOKEN) {
    throw new Error('PAPERCLIP_API_KEY is not set in the environment.');
  }

  const now = new Date();
  const dateLabel = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const slotKey = `${dateLabel}-${args.slot}`;
  const slotLabel = SLOT_LABELS[args.slot];

  const state = loadState();
  if (state.lastRunSlot === slotKey && !args.force && !args.dryRun) {
    console.log(`slot already ran today (${slotKey}); skipping. Use --force to override.`);
    process.exit(0);
  }

  const cursorFromIso =
    state.lastDoneCursor && state.lastDoneCursor.length > 0
      ? state.lastDoneCursor
      : new Date(now.getTime() - 12 * 3600 * 1000).toISOString();

  const issues = await papGet(`/api/companies/${COMPANY_ID}/issues?limit=500`);
  if (!Array.isArray(issues)) {
    throw new Error(`Unexpected issues payload: ${typeof issues}`);
  }
  const rawBuckets = bucketize(issues, cursorFromIso);
  const buckets = await enrichBuckets(rawBuckets);

  const data = {
    generatedAt: now.toISOString(),
    slotLabel,
    dateLabel,
    cursorFromIso,
    buckets,
  };
  const dataPath = join(SLIDE_DIR, 'data.json');
  writeAtomic(dataPath, JSON.stringify(data, null, 2) + '\n');

  const counts = {
    done: buckets.done.length,
    inProgress: buckets.inProgress.length,
    upNext: buckets.upNext.length,
    blockers: buckets.blockers.length,
  };

  const subject = `OpenRunner board report — ${dateLabel} ${slotLabel}`;
  const digest =
    `done ${counts.done} · in_progress ${counts.inProgress} · up_next ${counts.upNext} · blockers ${counts.blockers}`;
  const emailHtml = buildEmailHtml({ buckets, counts, slotLabel, dateLabel, generatedAt: data.generatedAt, cursorFromIso });
  const emailText = buildEmailText({ buckets, counts, slotLabel, dateLabel, generatedAt: data.generatedAt, cursorFromIso });
  const notifText = `${digest} — ${DECK_URL}`;

  if (args.dryRun) {
    console.log(`deck URL: ${DECK_URL}`);
    console.log(`buckets: done=${counts.done} in_progress=${counts.inProgress} up_next=${counts.upNext} blockers=${counts.blockers}`);
    console.log(`--- email (text) ---`);
    console.log(`To: ${RECIPIENT}`);
    console.log(`Subject: ${subject}`);
    console.log(``);
    console.log(emailText);
    console.log(`--- notification ---`);
    console.log(`title: OpenRunner board report`);
    console.log(`subtitle: ${slotLabel}`);
    console.log(`message: ${notifText}`);
    return;
  }

  await smokeDeck();
  await sendEmail({ subject, html: emailHtml, text: emailText });
  fireNotification({
    title: 'OpenRunner board report',
    subtitle: slotLabel,
    message: notifText,
    openUrl: DECK_URL,
  });

  saveState({
    lastRunSlot: slotKey,
    lastRunAt: now.toISOString(),
    lastDoneCursor: now.toISOString(),
  });
  console.log(`board-report ${slotKey} delivered. ${digest}`);
}

const __isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (__isMain) {
  const slotForFailure =
    (process.argv.slice(2).find((a) => a.startsWith('--slot=')) || '--slot=?').slice(7) || '?';
  main().catch(async (err) => {
    console.error(err.stack || err.message);
    try {
      await reportFailure(slotForFailure, err);
    } catch (reportErr) {
      console.error('failure-path itself errored:', reportErr.message);
    }
    process.exit(1);
  });
}
