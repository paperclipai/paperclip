'use strict';

/**
 * Send preflight — the control the Day-1 send step calls immediately before
 * dispatch. This is the answer to the K-20062 defect: the store had no
 * production caller, so an opt-out was honoured on paper and violated in
 * practice.
 *
 * Why this exists as a separate gate rather than a reuse of `filterImport`:
 * `filterImport` is an import filter, so silently dropping an unparseable
 * address is correct there. A *send* gate must fail closed — a check that
 * cannot prove an address is clear must never report "clear". Same store, same
 * `globally_suppressed` semantics; stricter contract. See DECISION-day1-send-path.md.
 *
 * Rules this module enforces:
 *   1. Fail closed. An unreadable or absent store blocks every recipient with
 *      `store_unavailable`. It never returns an empty `allowed` list.
 *   2. Read at dispatch time. `refresh()` re-reads the store on every call, so
 *      an opt-out recorded mid-batch suppresses the unsent remainder.
 *   3. No silent drops. An unparseable recipient is blocked with
 *      `invalid_recipient`, not skipped.
 *   4. Every exclusion is logged, append-only, with a reason — so a suppression
 *      is enforceable *and* attestable to Legal.
 *   5. The record is part of the gate. If the audit log cannot be written, the
 *      preflight is fatal with `audit_unavailable`: a dispatch that cannot be
 *      reconciled against the log afterwards cannot be shown to have honoured
 *      the store, so it does not happen. An unattributable send is the same
 *      failure as an unsuppressed one.
 *
 * Exit codes (CLI and HTTP both use these):
 *   0 = every recipient clear, send may proceed
 *   1 = at least one recipient blocked, do not send to the blocked addresses
 *   3 = store unreadable — the preflight cannot prove anything, send nothing
 *   4 = audit log unwritable — the dispatch cannot be attested, send nothing
 *   2 = usage error
 */

const fs = require('node:fs');
const path = require('node:path');
const { SuppressionList, normalizeEmail, resolveStorePath, DEFAULT_STORE_PATH } = require('./suppression.cjs');

const REASON_SUPPRESSED = 'globally_suppressed';
const REASON_INVALID = 'invalid_recipient';
const REASON_STORE_UNAVAILABLE = 'store_unavailable';
const REASON_AUDIT_UNAVAILABLE = 'audit_unavailable';

const EXIT = {
  CLEAR: 0,
  BLOCKED: 1,
  USAGE: 2,
  STORE_UNAVAILABLE: 3,
  AUDIT_UNAVAILABLE: 4,
};

const DEFAULT_AUDIT_PATH = path.join(__dirname, 'send-audit.log');

/**
 * The append-only audit log. Records every preflight and every recorded STOP,
 * including the reason for each exclusion. A suppressed address that is
 * correctly excluded is provable from this file alone.
 */
function resolveAuditPath(env = process.env) {
  return env.CAN_SPAM_AUDIT_LOG || DEFAULT_AUDIT_PATH;
}

function appendAudit(record, options = {}) {
  const auditPath = options.auditPath || resolveAuditPath(options.env);
  const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n';
  try {
    fs.appendFileSync(auditPath, line, { mode: 0o600 });
  } catch (err) {
    // An unwritable audit log must not be swallowed. The caller (writeAudit)
    // turns this into a fatal result, because a send whose record does not
    // exist cannot be reconciled against the store afterwards.
    return { ok: false, path: auditPath, error: err.message };
  }
  return { ok: true, path: auditPath };
}

/**
 * Preflight a recipient list against the global suppression store.
 *
 * @param {string[]} recipients
 * @param {object} [options]
 * @param {string|null} [options.campaign]   campaign id, for the audit record
 * @param {SuppressionList} [options.list]   inject a store (tests, same origin)
 * @param {string} [options.storePath]
 * @param {string|null} [options.auditPath]  null disables auditing
 * @param {boolean} [options.refresh]        re-read the store first (default true)
 * @returns {object} report
 */
function preflight(recipients, options = {}) {
  const campaign = options.campaign ?? null;
  const storePath = options.storePath || resolveStorePath(options.env);
  const list = options.list || new SuppressionList(storePath);
  if (options.refresh !== false && typeof list.refresh === 'function') {
    list.refresh();
  }

  const rows = Array.isArray(recipients) ? recipients : [];
  const checkedAt = new Date().toISOString();
  const fingerprint = list.fingerprint();

  // Rule 1 — fail closed. An unreadable store proves nothing about anyone.
  if (!list.isReadable()) {
    const blocked = rows.map((raw) => ({
      email: String(raw),
      reason: REASON_STORE_UNAVAILABLE,
      campaign,
    }));
    const report = {
      ok: false,
      fatal: true,
      exitCode: EXIT.STORE_UNAVAILABLE,
      storeReadable: false,
      storeError: list.loadError ? list.loadError.message : 'unknown',
      storePath,
      storeFingerprint: fingerprint,
      campaign,
      checkedAt,
      allowed: [],
      blocked,
    };
    writeAudit(report, options);
    return report;
  }

  const allowed = [];
  const blocked = [];
  for (const raw of rows) {
    // Rule 3 — no silent drops.
    const key = normalizeEmail(raw);
    if (!key) {
      blocked.push({ email: String(raw), reason: REASON_INVALID, campaign });
      continue;
    }
    const entry = list.entryFor(key);
    if (entry) {
      blocked.push({
        email: key,
        reason: REASON_SUPPRESSED,
        suppressedAt: entry.suppressedAt,
        source: entry.source,
        campaign,
      });
      continue;
    }
    allowed.push(key);
  }

  const report = {
    ok: blocked.length === 0,
    fatal: false,
    exitCode: blocked.length === 0 ? EXIT.CLEAR : EXIT.BLOCKED,
    storeReadable: true,
    storePath,
    storeFingerprint: fingerprint,
    campaign,
    checkedAt,
    allowed,
    blocked,
  };
  writeAudit(report, options);
  return report;
}

function writeAudit(report, options = {}) {
  if (options.auditPath === null) return { ok: false, skipped: true, explicit: true };
  const audit = appendAudit(
    {
      event: 'send_preflight',
      campaign: report.campaign,
      ok: report.ok,
      fatal: report.fatal,
      exitCode: report.exitCode,
      storeFingerprint: report.storeFingerprint,
      storeReadable: report.storeReadable,
      recipients: report.allowed.length + report.blocked.length,
      allowed: report.allowed,
      blocked: report.blocked.map((b) => ({ email: b.email, reason: b.reason, suppressedAt: b.suppressedAt, source: b.source })),
    },
    options
  );
  if (audit.ok) {
    report.audited = true;
    return audit;
  }
  // Rule 5 — the record is part of the control. Rewrite the report to close the
  // gate: the decision that was just taken cannot be attested, so no recipient
  // is cleared and the caller is told why. Every row the preflight looked at is
  // carried over — including the ones that were about to be allowed — so
  // nothing silently disappears from the report. The log entry that would have
  // recorded the decision is the very thing that failed to write.
  const rows = [
    ...report.allowed.map((email) => ({ email, reason: null })),
    ...report.blocked,
  ];
  report.audited = false;
  report.auditError = audit.error;
  report.auditPath = audit.path;
  report.fatal = true;
  report.ok = false;
  report.exitCode = EXIT.AUDIT_UNAVAILABLE;
  report.allowed = [];
  report.blocked = rows.map((row) => ({
    ...row,
    reason: REASON_AUDIT_UNAVAILABLE,
    priorReason: row.reason,
  }));
  return audit;
}

/**
 * Record a STOP / unsubscribe reply into the same global store the preflight
 * reads, so a reply opt-out and a web opt-out are honoured identically and
 * immediately (15 U.S.C. 7704(4)(C)(iii); 16 CFR 316.5).
 *
 * Receiving the reply needs inbound mail routing, which does not exist in this
 * repo and cannot exist before P3 lands a verified sending domain. This is the
 * processing half: whoever holds the mailbox (the CMO, per README 1a) hands the
 * parsed sender address here and the suppression takes effect on the next
 * preflight, with no further steps.
 */
function recordStopReply(email, options = {}) {
  const storePath = options.storePath || resolveStorePath(options.env);
  const list = options.list || new SuppressionList(storePath);
  const result = list.suppress(email, {
    source: options.source || 'stop-reply',
    campaign: options.campaign ?? null,
    reason: options.reason || 'recipient_stop_reply',
  });
  if (options.auditPath !== null) {
    const audit = appendAudit(
      {
        event: 'stop_reply_recorded',
        ok: result.ok,
        added: result.added === true,
        already: result.already === true,
        email: result.entry ? result.entry.email : String(email),
        reason: result.ok ? (result.already ? 'already_suppressed' : 'recorded') : result.reason,
        source: options.source || 'stop-reply',
        storeFingerprint: list.fingerprint(),
      },
      options
    );
    // The suppression itself is already durable in the store, and a missing
    // audit record must never un-suppress anyone. It is still reported, because
    // a STOP the log cannot account for is a gap Legal has to see.
    result.audited = audit.ok;
    if (!audit.ok) result.auditError = audit.error;
  }
  return result;
}

/**
 * 16 CFR 316.5 opt-out keywords. A reply is an opt-out if the body carries any
 * of these; the sender address is then suppressed globally.
 */
const STOP_KEYWORDS = ['stop', 'unsubscribe', 'cancel', 'remove', 'end', 'opt out', 'optout', 'opt-out', 'remove me'];

/**
 * Classify an inbound reply body as an opt-out request. Pure function so the
 * classification is provable by test rather than by whoever reads the mailbox.
 */
function parseStopReply(body) {
  const text = String(body || '').toLowerCase();
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    for (const keyword of STOP_KEYWORDS) {
      if (line === keyword || line.startsWith(`${keyword}`)) {
        return { isStopRequest: true, keyword, matchedLine: line };
      }
    }
  }
  return { isStopRequest: false, keyword: null, matchedLine: null };
}

module.exports = {
  preflight,
  recordStopReply,
  parseStopReply,
  appendAudit,
  resolveAuditPath,
  STOP_KEYWORDS,
  REASON_SUPPRESSED,
  REASON_INVALID,
  REASON_STORE_UNAVAILABLE,
  REASON_AUDIT_UNAVAILABLE,
  EXIT,
  DEFAULT_AUDIT_PATH,
  DEFAULT_STORE_PATH,
};
