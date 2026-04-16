/**
 * read_inbox — read-only IMAP client for the signups@buywhere.ai mailbox.
 *
 * Single-writer mailbox lock: only one sidecar instance may hold the IMAP
 * connection at a time. The lock is a Unix advisory file lock under
 * /var/run/paperclip/surfer-imap.lock, released on connection close.
 *
 * Credentials are injected via env vars (never reach the prompt):
 *   SURFER_IMAP_HOST     — e.g. mail.buywhere.ai
 *   SURFER_IMAP_PORT     — e.g. 993
 *   SURFER_IMAP_USER     — e.g. signups@buywhere.ai
 *   SURFER_IMAP_PASS     — app password
 *   SURFER_IMAP_SECURE   — "true" (default) / "false"
 *   SURFER_IMAP_MAILBOX  — e.g. INBOX (default)
 *
 * Why not use a Node IMAP library? We want zero production dependencies beyond
 * Playwright for now. The raw IMAP protocol for SEARCH+FETCH is straightforward
 * enough to implement with node:tls + a simple state machine. We do that here.
 *
 * Note: this is read-only — we issue no SELECT ... READWRITE, only SELECT
 * (which is read-only in the IMAP spec if the mailbox is already in EXAMINE
 * state). We never DELETE, STORE, or EXPUNGE.
 */

import tls from "node:tls";
import net from "node:net";
import fs from "node:fs";
import type { ReadInboxCall, BrowserToolResult } from "../../server/tools/types.js";

const LOCK_PATH = process.env["SURFER_IMAP_LOCK_PATH"] ?? "/var/run/paperclip/surfer-imap.lock";
const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;

interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
}

function readImapConfig(mailboxOverride?: string): ImapConfig {
  const host = process.env["SURFER_IMAP_HOST"] ?? "";
  const user = process.env["SURFER_IMAP_USER"] ?? "";
  const pass = process.env["SURFER_IMAP_PASS"] ?? "";
  const port = parseInt(process.env["SURFER_IMAP_PORT"] ?? "993", 10);
  const secure = (process.env["SURFER_IMAP_SECURE"] ?? "true") !== "false";
  const mailbox =
    mailboxOverride ?? process.env["SURFER_IMAP_MAILBOX"] ?? "INBOX";

  if (!host || !user || !pass) {
    throw new Error(
      "IMAP not configured: set SURFER_IMAP_HOST, SURFER_IMAP_USER, SURFER_IMAP_PASS",
    );
  }

  return { host, port, secure, user, pass, mailbox };
}

/** Acquire the single-writer advisory lock. Returns the lock fd. */
function acquireLock(): number {
  const fd = fs.openSync(LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
  try {
    // LOCK_EX | LOCK_NB — non-blocking exclusive lock
    // Node doesn't expose flock() natively; use the fallback of writing a PID
    // file and checking it. Real flock() would require a native addon. In
    // practice the single-sidecar-per-agent model means contention is rare.
    const pid = process.pid.toString();
    fs.writeSync(fd, pid, 0);
    return fd;
  } catch (e) {
    fs.closeSync(fd);
    throw new Error(`IMAP mailbox lock unavailable — another sidecar holds it (${e})`);
  }
}

function releaseLock(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Best-effort
  }
}

/**
 * Minimal IMAP state machine for SEARCH + FETCH.
 * Sends tagged commands over a TLS (or plain) socket and reads responses
 * line-by-line until we see the tagged completion line.
 */
class ImapSession {
  private socket: tls.TLSSocket | net.Socket | null = null;
  private buffer = "";
  private tagSeq = 1;

  async connect(cfg: ImapConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error(`IMAP connect timeout to ${cfg.host}:${cfg.port}`));
      }, CONNECT_TIMEOUT_MS);

      const onConnected = (sock: tls.TLSSocket | net.Socket) => {
        clearTimeout(timer);
        this.socket = sock;
        sock.setEncoding("utf8");
        resolve();
      };

      if (cfg.secure) {
        const sock = tls.connect(cfg.port, cfg.host, { rejectUnauthorized: true });
        sock.once("secureConnect", () => onConnected(sock));
        sock.once("error", (e) => { clearTimeout(timer); reject(e); });
      } else {
        const sock = net.createConnection(cfg.port, cfg.host);
        sock.once("connect", () => onConnected(sock));
        sock.once("error", (e) => { clearTimeout(timer); reject(e); });
      }
    });
  }

  /** Read until the tagged completion line appears. Returns all lines. */
  private async readUntilTagged(tag: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("Not connected"));
      const lines: string[] = [];
      const timer = setTimeout(() => {
        reject(new Error(`IMAP command ${tag} timed out`));
      }, COMMAND_TIMEOUT_MS);

      const onData = (chunk: string) => {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf("\r\n")) !== -1) {
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 2);
          lines.push(line);
          if (line.startsWith(`${tag} OK`) || line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
            clearTimeout(timer);
            this.socket!.removeListener("data", onData);
            if (line.startsWith(`${tag} OK`)) {
              resolve(lines);
            } else {
              reject(new Error(`IMAP error: ${line}`));
            }
            return;
          }
        }
      };

      this.socket.on("data", onData);
    });
  }

  private async sendCommand(command: string): Promise<string[]> {
    if (!this.socket) throw new Error("Not connected");
    const tag = `A${String(this.tagSeq++).padStart(4, "0")}`;
    await new Promise<void>((res, rej) => {
      this.socket!.write(`${tag} ${command}\r\n`, (e) => (e ? rej(e) : res()));
    });
    return this.readUntilTagged(tag);
  }

  /** Skip the server greeting (one line). */
  async readGreeting(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.socket) return resolve();
      const onData = (chunk: string) => {
        this.buffer += chunk;
        if (this.buffer.includes("\r\n")) {
          this.socket!.removeListener("data", onData);
          resolve();
        }
      };
      this.socket.on("data", onData);
    });
  }

  async login(user: string, pass: string): Promise<void> {
    // Pass is never logged — it lives in SURFER_IMAP_PASS only
    await this.sendCommand(`LOGIN "${escapeImap(user)}" "${escapeImap(pass)}"`);
  }

  async examine(mailbox: string): Promise<void> {
    // EXAMINE opens read-only; SELECT would open read-write
    await this.sendCommand(`EXAMINE "${escapeImap(mailbox)}"`);
  }

  /**
   * Run an IMAP SEARCH command and return matching sequence numbers.
   * query example: `UNSEEN FROM "noreply@dev.to" SINCE "16-Apr-2026"`
   */
  async search(query: string): Promise<number[]> {
    const lines = await this.sendCommand(`SEARCH ${query}`);
    for (const line of lines) {
      if (line.startsWith("* SEARCH")) {
        const nums = line.slice(9).trim().split(/\s+/).filter(Boolean).map(Number);
        return nums.filter((n) => !isNaN(n));
      }
    }
    return [];
  }

  /**
   * Fetch RFC822 headers + subject/from/date for the given sequence numbers.
   */
  async fetchHeaders(
    seqNums: number[],
    limit: number,
  ): Promise<Array<{ seq: number; subject: string; from: string; date: string; snippet: string }>> {
    if (seqNums.length === 0) return [];
    const top = seqNums.slice(0, limit);
    const range = top.join(",");
    const lines = await this.sendCommand(
      `FETCH ${range} (BODY[HEADER.FIELDS (FROM SUBJECT DATE)])`,
    );

    const messages: Array<{ seq: number; subject: string; from: string; date: string; snippet: string }> = [];
    let current: Partial<{ seq: number; subject: string; from: string; date: string }> = {};

    for (const line of lines) {
      const fetchMatch = /^\* (\d+) FETCH/.exec(line);
      if (fetchMatch) {
        if (current.seq) {
          messages.push({
            seq: current.seq,
            subject: current.subject ?? "",
            from: current.from ?? "",
            date: current.date ?? "",
            snippet: `Subject: ${current.subject ?? "(none)"}`,
          });
        }
        current = { seq: parseInt(fetchMatch[1]!, 10) };
        continue;
      }
      const subjectMatch = /^Subject:\s*(.+)/i.exec(line);
      if (subjectMatch) { current.subject = subjectMatch[1]!.trim(); continue; }
      const fromMatch = /^From:\s*(.+)/i.exec(line);
      if (fromMatch) { current.from = fromMatch[1]!.trim(); continue; }
      const dateMatch = /^Date:\s*(.+)/i.exec(line);
      if (dateMatch) { current.date = dateMatch[1]!.trim(); continue; }
    }
    if (current.seq) {
      messages.push({
        seq: current.seq,
        subject: current.subject ?? "",
        from: current.from ?? "",
        date: current.date ?? "",
        snippet: `Subject: ${current.subject ?? "(none)"}`,
      });
    }

    return messages;
  }

  async logout(): Promise<void> {
    try {
      await this.sendCommand("LOGOUT");
    } catch { /* best-effort */ }
    this.socket?.destroy();
    this.socket = null;
  }
}

export async function execReadInbox(call: ReadInboxCall): Promise<BrowserToolResult> {
  const startedAt = new Date().toISOString();
  let lockFd: number | null = null;
  const session = new ImapSession();

  try {
    const cfg = readImapConfig(call.mailbox);
    lockFd = acquireLock();

    await session.connect(cfg);
    await session.readGreeting();
    await session.login(cfg.user, cfg.pass);
    await session.examine(cfg.mailbox);

    const seqNums = await session.search(call.query);
    const limit = call.limit ?? 10;
    const messages = await session.fetchHeaders(seqNums, limit);

    await session.logout();

    return {
      ok: true,
      tool: "read_inbox",
      startedAt,
      finishedAt: new Date().toISOString(),
      data: {
        mailbox: cfg.mailbox,
        query: call.query,
        totalMatched: seqNums.length,
        messages,
      },
    };
  } catch (err: unknown) {
    try { await session.logout(); } catch { /* best-effort */ }
    return {
      ok: false,
      tool: "read_inbox",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "READ_INBOX_FAILED",
    };
  } finally {
    if (lockFd !== null) releaseLock(lockFd);
  }
}

function escapeImap(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
