'use strict';

/**
 * Global CAN-SPAM suppression list — single source of truth.
 *
 * One store, shared across every campaign and every list the company holds.
 * Both opt-out channels (web endpoint + monitored STOP mailbox) write here,
 * so an opt-out honoured on one channel is honoured on all of them. An address
 * on this list cannot be re-imported into any campaign or list, and the send
 * guard refuses to dispatch to it.
 *
 * Persistence: a single JSON file. The list is keyed by normalised email for
 * O(1) lookup and idempotent re-suppression.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_STORE_PATH = path.join(__dirname, 'suppression-list.json');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Write-serialisation. The store is one JSON file with two independent writers:
 * the opt-out origin (long-lived HTTP server) and operator tooling / the reply
 * forwarder (short-lived CLI). Without a lock the second writer's whole-file
 * write erases whatever the first recorded in the interval — an opt-out
 * confirmed to a recipient, then silently gone, then a send that a preflight
 * had cleared. The write path therefore takes an exclusive lock, re-reads the
 * file inside it, and merges, so a suppression can only ever be added.
 */
const LOCK_TIMEOUT_MS = 10000;
const LOCK_POLL_MS = 25;
/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 60000;

/**
 * The one place the store's location is decided.
 *
 * Both the opt-out origin (which serves {OPT_OUT_URL}) and the send preflight
 * resolve through here, so there is exactly one file behind exactly one reader
 * process. A store the send step cannot read is not a control.
 *
 * CAN_SPAM_STORE is canonical; OPTOUT_STORE is honoured for the existing
 * server/CLI entry points.
 */
function resolveStorePath(env = process.env) {
  return env.CAN_SPAM_STORE || env.OPTOUT_STORE || DEFAULT_STORE_PATH;
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

function newStore() {
  return {
    version: 1,
    description:
      'Global CAN-SPAM suppression list. Single source of truth across all campaigns and lists. Opt-outs recorded here cannot be re-imported.',
    entries: {},
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPathFor(storePath) {
  return `${storePath}.lock`;
}

function lockAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch (_err) {
    return 0;
  }
}

class SuppressionList {
  constructor(storePath = DEFAULT_STORE_PATH) {
    this.storePath = storePath;
    this.store = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        this.loadError = null;
        this.loadedFromDisk = true;
        return parsed;
      }
      this.loadError = new Error('unrecognised store shape');
      this.loadedFromDisk = true;
    } catch (err) {
      // Missing or unreadable store: start clean rather than crash. Callers that
      // must *prove* an address is clear (the send preflight) check loadError
      // and fail closed instead of reading an empty list as "nothing suppressed".
      this.loadError = err;
      this.loadedFromDisk = false;
    }
    return newStore();
  }

  /**
   * Re-read the store from disk. The send preflight calls this on every
   * invocation so an opt-out recorded mid-batch is observed by the next
   * dispatch decision, not only at batch start.
   */
  refresh() {
    this.store = this._load();
    return this;
  }

  /**
   * True when the backing file was read and parsed successfully. False means
   * "this list is empty because we could not read it" — never "nothing is
   * suppressed".
   */
  isReadable() {
    return this.loadError === null;
  }

  /**
   * True when the backing file exists at all. The difference matters on the
   * write path: a store that is absent can be created, a store that is present
   * but unreadable must never be overwritten (see `suppress`).
   */
  storeFileExists() {
    return fs.existsSync(this.storePath);
  }

  /**
   * Run `fn` holding an exclusive lock on the store, so two writers cannot
   * interleave a read-modify-write. A lock left behind by a process that died
   * is reclaimed once it is older than LOCK_STALE_MS, because a wedged store
   * would mean opt-outs could not be recorded at all.
   */
  _withLock(fn) {
    const lockPath = lockPathFor(this.storePath);
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let fd = null;
    for (;;) {
      try {
        fd = fs.openSync(lockPath, 'wx');
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (lockAgeMs(lockPath) > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for the suppression store lock at ${lockPath}`);
        }
        sleepSync(LOCK_POLL_MS);
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch (_err) {
        /* the lock is released by unlink regardless */
      }
      fs.rmSync(lockPath, { force: true });
    }
  }

  /**
   * The recorded opt-out for an address, or null. Lets a caller attach the
   * legally relevant metadata (suppressedAt, source) to a block decision
   * without re-deriving it.
   */
  entryFor(email) {
    const key = normalizeEmail(email);
    if (!key) return null;
    return this.store.entries[key] || null;
  }

  _persist() {
    // The store may be pointed at a path that does not exist yet (first
    // deployment, or CAN_SPAM_STORE moved). Create it rather than failing a
    // write — but never silently swallow a real write failure.
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2));
    fs.renameSync(tmp, this.storePath);
  }

  /** Public write, for operator tooling that mutates the store directly. */
  persist() {
    this._persist();
    return this;
  }

  isSuppressed(email) {
    const key = normalizeEmail(email);
    if (!key) return false;
    return Object.prototype.hasOwnProperty.call(this.store.entries, key);
  }

  /**
   * Record an opt-out. Idempotent: re-suppressing an existing address is a
   * no-op that returns already=true and never overwrites the original
   * suppressedAt timestamp (the first opt-out is the legally relevant one).
   *
   * Fails closed in the write direction. The read-modify-write happens under an
   * exclusive lock, re-reading the file first, so a second writer cannot erase
   * an opt-out recorded while this instance was holding an older copy. And if
   * the file exists but cannot be parsed, the write is refused outright: the
   * in-memory fallback is an empty list, and persisting it would replace real
   * opt-outs with nothing — the silent un-suppression `init` already refuses.
   */
  suppress(email, meta = {}) {
    const key = normalizeEmail(email);
    if (!key) {
      return { ok: false, reason: 'invalid_email', email: String(email) };
    }
    return this._withLock(() => {
      this.refresh();
      if (!this.isReadable() && this.storeFileExists()) {
        throw new Error(
          `suppression store at ${this.storePath} is unreadable (${this.loadError && this.loadError.message}); ` +
            'refusing to write, because doing so would overwrite the opt-outs it holds'
        );
      }
      const existing = this.store.entries[key];
      if (existing) {
        return { ok: true, added: false, already: true, entry: existing };
      }
      const entry = {
        email: key,
        suppressedAt: new Date().toISOString(),
        source: meta.source || 'unknown',
        campaign: meta.campaign || null,
        reason: meta.reason || 'opt-out',
      };
      this.store.entries[key] = entry;
      try {
        this._persist();
      } catch (err) {
        delete this.store.entries[key];
        throw err;
      }
      this.loadError = null;
      this.loadedFromDisk = true;
      return { ok: true, added: true, already: false, entry };
    });
  }

  list() {
    return Object.values(this.store.entries).sort((a, b) =>
      a.suppressedAt < b.suppressedAt ? -1 : 1
    );
  }

  count() {
    return Object.keys(this.store.entries).length;
  }

  /**
   * Import guard. Given a candidate list for a campaign, drop every address
   * that is on the global suppression list. This is what makes an opt-out
   * impossible to re-import: the filter runs at import time, before the
   * address ever reaches a send queue.
   */
  filterImport(emails, campaign = null) {
    const allowed = [];
    const blocked = [];
    for (const raw of emails || []) {
      const key = normalizeEmail(raw);
      if (!key) continue;
      if (this.isSuppressed(key)) {
        blocked.push({ email: key, campaign, reason: 'globally_suppressed' });
      } else {
        allowed.push(key);
      }
    }
    return { allowed, blocked };
  }

  /**
   * Send guard. Returns a result the dispatcher can branch on; the send path
   * must treat `allowed:false` as a hard stop.
   */
  guardSend(email, campaign = null) {
    const key = normalizeEmail(email);
    if (!key) return { allowed: false, reason: 'invalid_email', email: String(email) };
    const entry = this.store.entries[key];
    if (entry) {
      return { allowed: false, reason: 'globally_suppressed', email: key, suppressedAt: entry.suppressedAt, campaign };
    }
    return { allowed: true, email: key, campaign };
  }

  fingerprint() {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(this.store.entries));
    return hash.digest('hex').slice(0, 16);
  }
}

module.exports = { SuppressionList, normalizeEmail, resolveStorePath, newStore, DEFAULT_STORE_PATH };
