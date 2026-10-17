'use strict';

/**
 * CLI for the Day-1 send step. The Day-1 send is performed by an agent through
 * a connection, not a code path, so the agent needs a checkable way to prove an
 * address is clear before dispatch. See DECISION-day1-send-path.md.
 *
 * Usage:
 *   node marketing/can-spam/check-suppression.cjs preflight <file> [--campaign <name>]
 *   node marketing/can-spam/check-suppression.cjs init
 *   node marketing/can-spam/check-suppression.cjs stop <email> [--campaign <name>]
 *   node marketing/can-spam/check-suppression.cjs check <email>
 *   node marketing/can-spam/check-suppression.cjs batch <file-with-one-email-per-line>
 *   node marketing/can-spam/check-suppression.cjs list
 *
 * Exit codes:
 *   0 = all clear (or listing)
 *   1 = at least one address is suppressed
 *   2 = usage error
 *   3 = store unreadable — the preflight cannot prove anything, send nothing
 *   4 = audit log unwritable — the dispatch cannot be attested, send nothing
 *
 * `preflight` is the command the send step must call immediately before
 * dispatch. It re-reads the store on every call, so an opt-out recorded
 * mid-batch suppresses the unsent remainder. It fails closed: an unreadable
 * store exits 3 rather than reporting a clear list.
 *
 * The store is created explicitly by `init`, not by a send. A machine with no
 * store cannot certify anyone, which is the intended behaviour — "not set up"
 * and "nobody is suppressed" are different facts.
 */

const fs = require('node:fs');
const { SuppressionList, resolveStorePath, newStore } = require('./suppression.cjs');
const { preflight, recordStopReply, parseStopReply, EXIT } = require('./preflight.cjs');

const STORE_PATH = resolveStorePath();
const list = new SuppressionList(STORE_PATH);

function usage() {
  process.stderr.write('Usage:\n');
  process.stderr.write('  check-suppression.cjs preflight <file> [--campaign <name>]   # call before every dispatch\n');
  process.stderr.write('  check-suppression.cjs init                                # create the store (operator action)\n');
  process.stderr.write('  check-suppression.cjs stop <email> [--campaign <name>]\n');
  process.stderr.write('  check-suppression.cjs check <email>\n');
  process.stderr.write('  check-suppression.cjs batch <file>\n');
  process.stderr.write('  check-suppression.cjs list\n');
  process.exit(EXIT.USAGE);
}

/**
 * Create the store explicitly. Refuses to overwrite an existing one — a lost
 * list must never be silently replaced by an empty one, which would un-suppress
 * every opted-out address in the company.
 */
function cmdInit() {
  if (fs.existsSync(STORE_PATH)) {
    const existing = new SuppressionList(STORE_PATH);
    if (!existing.isReadable()) {
      process.stderr.write(
        `REFUSING to init: ${STORE_PATH} exists but is unreadable (${existing.loadError.message}).\n` +
          'Restore it from backup. Initialising here would discard real opt-outs.\n'
      );
      process.exit(EXIT.STORE_UNAVAILABLE);
    }
    process.stdout.write(
      `EXISTS ${STORE_PATH} — ${existing.count()} entries, fingerprint ${existing.fingerprint()}. Nothing changed.\n`
    );
    process.exit(EXIT.CLEAR);
  }
  const created = new SuppressionList(STORE_PATH);
  created.store = newStore();
  created.persist();
  fs.chmodSync(STORE_PATH, 0o600);
  process.stdout.write(`CREATED ${STORE_PATH} — 0 entries, fingerprint ${created.fingerprint()}\n`);
  process.exit(EXIT.CLEAR);
}

function parseFlag(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1] || null;
}

function readRecipients(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/[\n,;]+/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    process.stderr.write(`Error reading file: ${err.message}\n`);
    process.exit(EXIT.USAGE);
  }
}

function cmdPreflight(file) {
  const report = preflight(readRecipients(file), {
    list,
    storePath: STORE_PATH,
    campaign: parseFlag('--campaign'),
  });

  if (report.fatal) {
    const why =
      report.exitCode === EXIT.AUDIT_UNAVAILABLE
        ? `FATAL audit_unavailable (${report.auditError})\nAudit log: ${report.auditPath}`
        : `FATAL store_unavailable (${report.storeError})\nStore: ${report.storePath}`;
    process.stderr.write(
      `${why}\n` +
        `Suppression status could not be proven for ${report.blocked.length} recipient(s). Send nothing.\n`
    );
    process.exit(report.exitCode);
  }

  for (const email of report.allowed) {
    process.stdout.write(`ALLOW ${email}\n`);
  }
  for (const entry of report.blocked) {
    const detail = entry.suppressedAt ? ` suppressedAt=${entry.suppressedAt} source=${entry.source}` : '';
    process.stdout.write(`BLOCK ${entry.email} reason=${entry.reason}${detail}\n`);
  }
  process.stdout.write(
    `\nSummary: ${report.allowed.length} allowed, ${report.blocked.length} blocked, ` +
      `${report.allowed.length + report.blocked.length} total\n` +
      `Store fingerprint: ${report.storeFingerprint}\n` +
      `Campaign: ${report.campaign || '(none)'}\n` +
      `Checked at: ${report.checkedAt}\n`
  );
  if (report.blocked.length > 0) {
    process.stdout.write('\nDo not send to any BLOCK address. Record the exclusion and continue with the rest.\n');
  }
  process.exit(report.exitCode);
}

function cmdStop(email) {
  const result = recordStopReply(email, { list, storePath: STORE_PATH, campaign: parseFlag('--campaign') });
  if (!result.ok) {
    process.stderr.write(`Cannot record STOP for ${email}: ${result.reason}\n`);
    process.exit(EXIT.USAGE);
  }
  process.stdout.write(
    result.already
      ? `ALREADY_SUPPRESSED ${result.entry.email} suppressedAt=${result.entry.suppressedAt}\n`
      : `SUPPRESSED ${result.entry.email} suppressedAt=${result.entry.suppressedAt}\n`
  );
  process.stdout.write('Recorded to the global store; blocked from all sends immediately.\n');
  process.exit(EXIT.CLEAR);
}

function cmdStopParse(file) {
  const body = fs.readFileSync(file, 'utf8');
  const parsed = parseStopReply(body);
  process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
  process.exit(parsed.isStopRequest ? EXIT.CLEAR : EXIT.BLOCKED);
}

function cmdCheck(email) {
  const result = list.guardSend(email);
  if (result.allowed) {
    process.stdout.write(`ALLOW ${result.email}\n`);
    process.exit(0);
  } else {
    process.stdout.write(`BLOCK ${result.email} reason=${result.reason} suppressedAt=${result.suppressedAt}\n`);
    process.exit(1);
  }
}

function cmdBatch(file) {
  let emails;
  try {
    emails = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    process.stderr.write(`Error reading file: ${err.message}\n`);
    process.exit(2);
  }

  const { allowed, blocked } = list.filterImport(emails);

  for (const email of allowed) {
    process.stdout.write(`ALLOW ${email}\n`);
  }
  for (const entry of blocked) {
    process.stdout.write(`BLOCK ${entry.email} reason=${entry.reason}\n`);
  }

  process.stdout.write(`\nSummary: ${allowed.length} allowed, ${blocked.length} blocked, ${emails.length} total\n`);

  if (blocked.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

function cmdList() {
  const entries = list.list();
  process.stdout.write(`Global suppression list — ${entries.length} entries\n`);
  process.stdout.write(`Fingerprint: ${list.fingerprint()}\n`);
  process.stdout.write(`Store: ${STORE_PATH}\n\n`);
  for (const entry of entries) {
    process.stdout.write(`${entry.email}  suppressedAt=${entry.suppressedAt}  source=${entry.source}\n`);
  }
  process.exit(0);
}

const [,, cmd, arg] = process.argv;

switch (cmd) {
  case 'preflight':
    if (!arg) usage();
    cmdPreflight(arg);
    break;
  case 'init':
    cmdInit();
    break;
  case 'stop':
    if (!arg) usage();
    cmdStop(arg);
    break;
  case 'stop-parse':
    if (!arg) usage();
    cmdStopParse(arg);
    break;
  case 'check':
    if (!arg) usage();
    cmdCheck(arg);
    break;
  case 'batch':
    if (!arg) usage();
    cmdBatch(arg);
    break;
  case 'list':
    cmdList();
    break;
  default:
    usage();
}
