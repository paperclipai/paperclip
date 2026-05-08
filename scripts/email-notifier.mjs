#!/usr/bin/env node
// Stop-gap email notifier for Paperclip events that need the human board.
// Polls approvals + blocked issues, dedupes via state file, emails via Resend.
// Run via LaunchAgent (see ~/Library/LaunchAgents/io.paperclip.openrunner.notifier.plist).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// ─── Config (from env) ────────────────────────────────────────────────────────
const PAPERCLIP_URL = process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3101';
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || '050de589-23d3-40bb-b227-efea13164d01';
const COMPANY_SHORTNAME = process.env.PAPERCLIP_COMPANY_SHORTNAME || 'GLA';
const FROM = process.env.NOTIFIER_FROM || 'jlqueguiner@gladia.io';
const TO = process.env.NOTIFIER_TO || 'jlqueguiner@gladia.io';
const RESEND_KEY = process.env.RESEND_API_KEY;
const STATE_FILE = process.env.NOTIFIER_STATE_FILE
  || '/Users/jlqueguiner/.paperclip-worktrees/instances/paperclip-openrunner/state/email-notifier.json';
const BOOTSTRAP_NOTIFY = process.env.NOTIFIER_BOOTSTRAP_NOTIFY === 'true';
const ASSET_LIBRARY_URL = (process.env.ASSET_LIBRARY_URL || 'http://127.0.0.1:7700').replace(/\/$/, '');
const ASSET_THUMBNAIL_MAX_BYTES = Number(process.env.ASSET_LIBRARY_THUMBNAIL_MAX_BYTES || 200_000);

if (!RESEND_KEY) {
  console.error('RESEND_API_KEY missing. Set in the LaunchAgent env or .env file.');
  process.exit(2);
}

const PAPERCLIP_TOKEN = process.env.PAPERCLIP_API_KEY || '';

// ─── State ────────────────────────────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return { seenApprovalIds: [], seenBlockedIssueIds: [], lastRunAt: null };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { seenApprovalIds: [], seenBlockedIssueIds: [], lastRunAt: null };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, STATE_FILE);
}

// ─── Paperclip API ────────────────────────────────────────────────────────────
async function pap(path) {
  const headers = {};
  if (PAPERCLIP_TOKEN) headers.Authorization = `Bearer ${PAPERCLIP_TOKEN}`;
  const res = await fetch(`${PAPERCLIP_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function fetchPendingApprovals() {
  const all = await pap(`/api/companies/${COMPANY_ID}/approvals?limit=200`);
  const items = Array.isArray(all) ? all : (all.data ?? []);
  return items.filter((a) => a.status === 'pending' || a.status === 'requested');
}

async function fetchBlockedNeedsAttention() {
  const all = await pap(`/api/companies/${COMPANY_ID}/issues?status=blocked&limit=200`);
  const items = Array.isArray(all) ? all : (all.data ?? []);
  return items.filter((i) => (i.blockerAttention?.state ?? '') === 'needs_attention');
}

// ─── Resend ───────────────────────────────────────────────────────────────────
async function sendEmail({ subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: [TO], subject, text, html }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`Resend ${res.status}: ${JSON.stringify(body)}`);
    return null;
  }
  return body?.id ?? null;
}

// ─── Email builders ───────────────────────────────────────────────────────────
const dashboardBase = () => PAPERCLIP_URL.replace(/\/$/, '');
const approvalUrl = (id) => `${dashboardBase()}/${COMPANY_SHORTNAME}/approvals/${id}`;
const issueUrl = (identifier) => `${dashboardBase()}/${COMPANY_SHORTNAME}/issues/${identifier}`;

// ─── Asset-review detection + builders ───────────────────────────────────────
const ASSET_REVIEW_TITLE_PREFIXES = ['[review-and-ship]', '[marketing-asset]'];

function isAssetReviewIssue(issue) {
  if (!issue) return false;
  const title = String(issue.title || '').trim().toLowerCase();
  for (const p of ASSET_REVIEW_TITLE_PREFIXES) {
    if (title.startsWith(p)) return true;
  }
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  for (const l of labels) {
    const slug = String(l?.slug || l?.name || l || '').toLowerCase();
    if (slug === 'review-and-ship' || slug === 'marketing-asset') return true;
  }
  return false;
}

function assetCtaUrl(issueId, docKey) {
  if (docKey) return `${ASSET_LIBRARY_URL}/asset/${issueId}/${encodeURIComponent(docKey)}`;
  return `${ASSET_LIBRARY_URL}/asset/${issueId}`;
}

async function fetchIssueDocs(issueId) {
  try {
    const docs = await pap(`/api/issues/${issueId}/documents`);
    const list = Array.isArray(docs) ? docs : (docs?.data ?? []);
    return list;
  } catch {
    return [];
  }
}

async function fetchDocPreview(issueId, key) {
  try {
    const doc = await pap(`/api/issues/${issueId}/documents/${encodeURIComponent(key)}`);
    return doc?.body || doc?.latestBody || '';
  } catch {
    return '';
  }
}

async function fetchIssueAttachments(issueId) {
  try {
    const list = await pap(`/api/issues/${issueId}/attachments`);
    return Array.isArray(list) ? list : (list?.data ?? []);
  } catch {
    return [];
  }
}

function attachmentMime(a) {
  return String(a?.mimeType || a?.contentType || '').toLowerCase();
}

function pickInlineThumbnail(attachments) {
  return attachments.find((a) => /^image\/(png|jpe?g|gif|webp)$/.test(attachmentMime(a))) || null;
}

function pickVideoAttachment(attachments) {
  return attachments.find((a) => attachmentMime(a).startsWith('video/')) || null;
}

async function fetchAttachmentDataUri(attachment) {
  const id = attachment?.id;
  const mime = attachmentMime(attachment);
  if (!id || !mime) return null;
  if ((attachment?.size ?? 0) > ASSET_THUMBNAIL_MAX_BYTES) return null;
  try {
    const headers = {};
    if (PAPERCLIP_TOKEN) headers.Authorization = `Bearer ${PAPERCLIP_TOKEN}`;
    const res = await fetch(`${PAPERCLIP_URL}/api/attachments/${id}/content`, { headers });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > ASSET_THUMBNAIL_MAX_BYTES) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function docPreview80(body) {
  if (!body) return '';
  const flat = String(body).replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? flat.slice(0, 79) + '…' : flat;
}

async function buildAssetReviewEmail(issue, headline) {
  const issueDashUrl = issueUrl(issue.identifier);
  const docs = await fetchIssueDocs(issue.id);
  const attachments = await fetchIssueAttachments(issue.id);
  const thumbAtt = pickInlineThumbnail(attachments);
  const videoAtt = pickVideoAttachment(attachments);
  const thumbDataUri = thumbAtt ? await fetchAttachmentDataUri(thumbAtt) : null;
  const videoUrl = videoAtt ? `${PAPERCLIP_URL.replace(/\/$/, '')}/api/attachments/${videoAtt.id}/content` : null;

  const docCtas = docs.length > 0
    ? docs.map((d) => ({ key: d.key, title: d.title || d.key, format: d.format, url: assetCtaUrl(issue.id, d.key) }))
    : [{ key: null, title: 'Asset', format: null, url: assetCtaUrl(issue.id, null) }];

  // Per-doc previews (only fetch for text/markdown to keep cost bounded)
  for (const c of docCtas) {
    if (!c.key) continue;
    if (c.format === 'markdown' || c.format === 'text' || c.format === 'plain') {
      const body = await fetchDocPreview(issue.id, c.key);
      c.preview = docPreview80(body);
    }
  }

  const subject = `[asset-review] ${issue.identifier} — ${truncate(issue.title, 80)}`;

  const textLines = [
    headline || `Asset review needed: ${issue.identifier}`,
    `${issue.identifier} — ${issue.title}`,
    '',
  ];
  for (const c of docCtas) {
    textLines.push(`▶ ${c.title}: ${c.url}`);
    if (c.preview) textLines.push(`  ${c.preview}`);
  }
  if (videoUrl) textLines.push(`▶ Watch video: ${videoUrl}`);
  textLines.push('', `Issue: ${issueDashUrl}`, '', `Issue id: ${issue.id}`);
  const text = textLines.join('\n');

  const docHtmlBlocks = docCtas.map((c) => {
    const previewHtml = c.preview ? `<div style="color:#666;font-size:12px;margin:2px 0 0 0;">${escapeHtml(c.preview)}</div>` : '';
    return `<li style="margin:8px 0;">
      <a href="${escapeHtml(c.url)}" style="color:#06c;font-weight:600;text-decoration:none;">▶ ${escapeHtml(c.title)}</a>
      ${previewHtml}
    </li>`;
  }).join('');

  const thumbHtml = thumbDataUri
    ? `<div style="margin:8px 0;"><img src="${thumbDataUri}" alt="thumbnail" style="max-width:480px;max-height:320px;border:1px solid #eee;border-radius:6px;"></div>`
    : '';
  const videoHtml = videoUrl
    ? `<div style="margin:8px 0;"><a href="${escapeHtml(videoUrl)}" style="color:#06c;">▶ Watch video</a></div>`
    : '';

  const html = `
    <h3 style="margin:0 0 6px 0;">${escapeHtml(headline || 'Asset review needed')}</h3>
    <p style="margin:0 0 8px 0;"><strong>${escapeHtml(issue.identifier)}</strong> — ${escapeHtml(issue.title)}</p>
    ${thumbHtml}
    ${videoHtml}
    <ul style="list-style:none;padding-left:0;margin:8px 0;">${docHtmlBlocks}</ul>
    <p style="margin:12px 0 0 0;"><a href="${escapeHtml(issueDashUrl)}" style="color:#888;font-size:12px;">Open issue in Paperclip →</a></p>
    <p style="color:#888;font-size:11px;margin-top:8px;">Issue id: ${escapeHtml(issue.id)}</p>
  `;
  return { subject, text, html };
}

function buildApprovalEmail(approval) {
  const url = approvalUrl(approval.id);
  const type = approval.type ?? 'approval';
  const note = approval.decisionNote ?? approval.payload?.summary ?? approval.payload?.title ?? '';
  const subject = `[Paperclip-${COMPANY_SHORTNAME}] Approval needed: ${type}${note ? ' — ' + truncate(note, 80) : ''}`;
  const text = [
    `Type:    ${type}`,
    `Status:  ${approval.status}`,
    note ? `Note:    ${truncate(note, 300)}` : '',
    '',
    `Open in dashboard: ${url}`,
    '',
    `Approval id: ${approval.id}`,
  ].filter(Boolean).join('\n');
  const html = `
    <h3>Approval needed</h3>
    <p><strong>Type:</strong> ${escapeHtml(type)}<br>
       <strong>Status:</strong> ${escapeHtml(approval.status)}</p>
    ${note ? `<p>${escapeHtml(truncate(note, 300))}</p>` : ''}
    <p><a href="${url}">Open in Paperclip dashboard →</a></p>
    <p style="color:#888;font-size:12px;">Approval id: ${approval.id}</p>
  `;
  return { subject, text, html };
}

function buildBlockedEmail(issue) {
  const url = issueUrl(issue.identifier);
  const blocker = issue.blockerAttention?.sampleBlockerIdentifier ?? '?';
  const subject = `[Paperclip-${COMPANY_SHORTNAME}] Issue blocked, needs human: ${issue.identifier} — ${truncate(issue.title, 60)}`;
  const text = [
    `${issue.identifier} — ${issue.title}`,
    `Status:           blocked (needs_attention)`,
    `Sample blocker:   ${blocker}`,
    `Unresolved:       ${issue.blockerAttention?.unresolvedBlockerCount ?? '?'}`,
    `Attention count:  ${issue.blockerAttention?.attentionBlockerCount ?? '?'}`,
    '',
    `Open in dashboard: ${url}`,
    '',
    `Issue id: ${issue.id}`,
  ].join('\n');
  const html = `
    <h3>Issue blocked — needs human attention</h3>
    <p><strong>${escapeHtml(issue.identifier)}</strong> — ${escapeHtml(issue.title)}</p>
    <ul>
      <li>Sample blocker: ${escapeHtml(blocker)}</li>
      <li>Unresolved blockers: ${issue.blockerAttention?.unresolvedBlockerCount ?? '?'}</li>
      <li>Attention-needing: ${issue.blockerAttention?.attentionBlockerCount ?? '?'}</li>
    </ul>
    <p><a href="${url}">Open in Paperclip dashboard →</a></p>
    <p style="color:#888;font-size:12px;">Issue id: ${issue.id}</p>
  `;
  return { subject, text, html };
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const state = loadState();
  const isFirstRun = !state.lastRunAt;
  const seenApprovals = new Set(state.seenApprovalIds);
  const seenBlocked = new Set(state.seenBlockedIssueIds);

  let sentCount = 0;

  // 1. Approvals
  let approvals = [];
  try { approvals = await fetchPendingApprovals(); }
  catch (e) { console.error(`fetchPendingApprovals: ${e.message}`); }

  for (const a of approvals) {
    if (seenApprovals.has(a.id)) continue;
    seenApprovals.add(a.id);
    if (isFirstRun && !BOOTSTRAP_NOTIFY) continue;
    const id = await sendEmail(buildApprovalEmail(a));
    if (id) { sentCount++; console.log(`approval ${a.id} -> email ${id}`); }
  }

  // 2. Blocked needs-attention
  let blocked = [];
  try { blocked = await fetchBlockedNeedsAttention(); }
  catch (e) { console.error(`fetchBlockedNeedsAttention: ${e.message}`); }

  for (const i of blocked) {
    if (seenBlocked.has(i.id)) continue;
    seenBlocked.add(i.id);
    if (isFirstRun && !BOOTSTRAP_NOTIFY) continue;
    const payload = isAssetReviewIssue(i)
      ? await buildAssetReviewEmail(i, `Asset review needed — ${i.identifier} blocked`)
      : buildBlockedEmail(i);
    const id = await sendEmail(payload);
    if (id) { sentCount++; console.log(`blocked ${i.identifier} -> email ${id}`); }
  }

  // Persist (cap state size: keep last 1000 ids)
  saveState({
    seenApprovalIds: Array.from(seenApprovals).slice(-1000),
    seenBlockedIssueIds: Array.from(seenBlocked).slice(-1000),
    lastRunAt: new Date().toISOString(),
  });

  console.log(`tick: approvals_pending=${approvals.length} blocked_needs_attention=${blocked.length} new_emails=${sentCount} firstRun=${isFirstRun}`);
}

main().catch((e) => {
  console.error(`notifier failed: ${e.stack ?? e.message ?? e}`);
  process.exit(1);
});
