/**
 * Multi-Agent Trade Consensus
 *
 * Implements a 2-of-2 vote gate that must pass before any trade is executed.
 * Protects against:
 *   - Laggy ICP agent double-execution (each proposal carries a monotonic nonce)
 *   - Solo-agent trading (both agents must sign within the 30-second window)
 *   - Replay attacks (nonce is unique per proposal; votes bind nonce + agentId)
 *
 * Flow:
 *   1. Any agent calls proposeConsensus(signal) → returns sessionId + nonce
 *   2. Both agents call castVote(sessionId, agentId, signature, approve=true)
 *      Signature covers: sha256(sessionId + ":" + nonce + ":" + agentId + ":approve")
 *   3. TradeConsensusManager.watchSession() resolves APPROVED once both votes arrive
 *      or CANCELLED if the 30-second window expires with < 2 approvals.
 *   4. Callers MUST await the result and abort if status !== 'approved'.
 */

import crypto from 'node:crypto';

// ── Constants ────────────────────────────────────────────────────────────────

/** Hard deadline: both agents must vote within this window or the trade cancels. */
export const CONSENSUS_TIMEOUT_MS = 30_000;

/** Required number of approving votes before a trade may fire. */
export const REQUIRED_VOTES = 2;

// ── Domain Types ─────────────────────────────────────────────────────────────

/** Chain where an agent lives. */
export type AgentChain = 'icp' | 'solana';

/** The direction of a trade. */
export type TradeDirection = 'buy' | 'sell';

/** A trade intent submitted by a strategy or signal generator. */
export interface TradeSignal {
  /** Asset pair, e.g. "SOL/USDC" */
  pair: string;
  direction: TradeDirection;
  /** Quantity expressed as a string to avoid float precision loss */
  quantity: string;
  /** Maximum acceptable price (limit) or undefined for market orders */
  limitPrice?: string;
  /** Originating chain */
  chain: AgentChain;
  /** ISO-8601 timestamp */
  requestedAt: string;
}

/** An agent's vote on a consensus proposal. */
export interface ConsensusVote {
  agentId: string;
  chain: AgentChain;
  /** HMAC-SHA256 over the canonical vote payload (see signVote / verifyVote) */
  signature: string;
  /** Echo of the session nonce — must match the proposal to be accepted */
  nonce: string;
  /** true = approve, false = veto */
  approve: boolean;
  /** ISO-8601 */
  votedAt: string;
}

/** Lifecycle states of a consensus session. */
export type ConsensusStatus =
  | 'pending'   // waiting for votes
  | 'approved'  // both agents confirmed — trade may execute
  | 'cancelled' // timeout or veto — trade must NOT execute
  | 'expired';  // cleaned up after final state reached

/** A single round of consensus for one trade signal. */
export interface ConsensusSession {
  sessionId: string;
  /** One-time random value — included in every vote signature to prevent replay */
  nonce: string;
  signal: TradeSignal;
  status: ConsensusStatus;
  votes: ConsensusVote[];
  createdAt: string;
  /** Set when status moves to approved/cancelled */
  resolvedAt?: string;
  /** Human-readable reason for cancellation */
  cancelReason?: string;
}

// ── Signature Helpers ────────────────────────────────────────────────────────

/**
 * Canonical vote payload string.
 *
 * Both agents must agree on this format — any deviation makes the signature invalid.
 */
function votePayload(
  sessionId: string,
  nonce: string,
  agentId: string,
  approve: boolean,
): string {
  const decision = approve ? 'approve' : 'veto';
  return `${sessionId}:${nonce}:${agentId}:${decision}`;
}

/**
 * Sign a vote using HMAC-SHA256.
 *
 * @param agentSecret - 32-byte (or longer) secret key unique to this agent.
 *                      On ICP this can be derived from a VetKey.
 *                      On Solana this can be derived from the wallet keypair.
 */
export function signVote(
  sessionId: string,
  nonce: string,
  agentId: string,
  approve: boolean,
  agentSecret: Buffer,
): string {
  const payload = votePayload(sessionId, nonce, agentId, approve);
  return crypto
    .createHmac('sha256', agentSecret)
    .update(payload)
    .digest('hex');
}

/**
 * Verify a vote signature using timing-safe comparison.
 *
 * @returns true if the signature is valid.
 */
export function verifyVote(vote: ConsensusVote, sessionId: string, agentSecret: Buffer): boolean {
  const expected = signVote(sessionId, vote.nonce, vote.agentId, vote.approve, agentSecret);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(vote.signature, 'hex');
  // Buffers must be same length for timingSafeEqual; reject mismatched lengths.
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// ── TradeConsensusManager ────────────────────────────────────────────────────

export interface ConsensusManagerOptions {
  /**
   * Shared secrets for each agent, keyed by agentId.
   *
   * In production these are fetched from VetKeys or the wallet HSM.
   * They must NEVER be logged or stored in plaintext.
   */
  agentSecrets: Map<string, Buffer>;
  /** Override the default 30-second timeout (useful in tests). */
  timeoutMs?: number;
  /** Optional hook called whenever a session changes state. */
  onSessionUpdate?: (session: ConsensusSession) => void;
}

/**
 * Manages the full lifecycle of multi-agent trade consensus sessions.
 *
 * Thread-safety note: JS is single-threaded, so Map operations are safe.
 * However, the 30-second timer fires asynchronously — always check session
 * status before acting on a resolved promise.
 */
export class TradeConsensusManager {
  private readonly sessions = new Map<string, ConsensusSession>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly opts: Required<ConsensusManagerOptions>;

  constructor(options: ConsensusManagerOptions) {
    this.opts = {
      agentSecrets: options.agentSecrets,
      timeoutMs: options.timeoutMs ?? CONSENSUS_TIMEOUT_MS,
      onSessionUpdate: options.onSessionUpdate ?? (() => {}),
    };
  }

  // ── Propose ───────────────────────────────────────────────────────────────

  /**
   * Open a new consensus session for a trade signal.
   *
   * @returns The session (status = 'pending').  Callers should then
   *          distribute the sessionId + nonce to both agents so they can vote.
   */
  proposeConsensus(signal: TradeSignal): ConsensusSession {
    const sessionId = `cs_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const nonce = crypto.randomBytes(16).toString('hex');

    const session: ConsensusSession = {
      sessionId,
      nonce,
      signal,
      status: 'pending',
      votes: [],
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, session);

    // Arm the 30-second kill timer.
    const timer = setTimeout(() => {
      this._expire(sessionId, 'timeout: 30-second window elapsed without 2 approvals');
    }, this.opts.timeoutMs);

    // Allow Node to exit even if a session is pending (don't block teardown).
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }

    this.timers.set(sessionId, timer);
    this.opts.onSessionUpdate(session);
    return { ...session };
  }

  // ── Vote ──────────────────────────────────────────────────────────────────

  /**
   * Cast an agent's vote on a pending session.
   *
   * Accepts only if:
   *   1. The session exists and is still 'pending'.
   *   2. The nonce in the vote matches the session nonce (anti-replay).
   *   3. The agent secret is registered in the manager.
   *   4. The HMAC-SHA256 signature over the canonical payload verifies.
   *   5. The agentId has not already voted in this session (no double-vote).
   *
   * @returns The updated session snapshot.
   * @throws If the session is not found, already resolved, or the vote is invalid.
   */
  castVote(sessionId: string, vote: ConsensusVote): ConsensusSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Consensus session not found: ${sessionId}`);
    }
    if (session.status !== 'pending') {
      throw new Error(
        `Session ${sessionId} is already ${session.status} — votes are no longer accepted`,
      );
    }

    // Anti-replay: nonce must exactly match.
    if (vote.nonce !== session.nonce) {
      throw new Error(`Vote nonce mismatch for session ${sessionId} — possible replay attack`);
    }

    // Check for duplicate vote from this agent.
    if (session.votes.some((v) => v.agentId === vote.agentId)) {
      throw new Error(`Agent ${vote.agentId} has already voted in session ${sessionId}`);
    }

    // Verify signature.
    const secret = this.opts.agentSecrets.get(vote.agentId);
    if (!secret) {
      throw new Error(`Unknown agentId ${vote.agentId} — no secret registered`);
    }
    if (!verifyVote(vote, sessionId, secret)) {
      throw new Error(`Invalid vote signature from agent ${vote.agentId}`);
    }

    // Record the vote.
    session.votes.push({ ...vote });

    // If any agent vetoes, cancel immediately — no trade.
    if (!vote.approve) {
      this._resolve(session, 'cancelled', `agent ${vote.agentId} vetoed the trade`);
      return { ...session };
    }

    // Check if we have reached the required quorum.
    const approvals = session.votes.filter((v) => v.approve).length;
    if (approvals >= REQUIRED_VOTES) {
      this._resolve(session, 'approved');
    } else {
      this.opts.onSessionUpdate(session);
    }

    return { ...session };
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /** Return a snapshot of a session, or undefined if not found. */
  getSession(sessionId: string): ConsensusSession | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : undefined;
  }

  /** Return all sessions that match a given status. */
  listSessions(status?: ConsensusStatus): ConsensusSession[] {
    const result: ConsensusSession[] = [];
    for (const s of this.sessions.values()) {
      if (!status || s.status === status) {
        result.push({ ...s });
      }
    }
    return result;
  }

  // ── Watch ─────────────────────────────────────────────────────────────────

  /**
   * Await the final outcome of a consensus session.
   *
   * Resolves once the session reaches 'approved' or 'cancelled'.
   * The returned status is authoritative — callers must check it before executing
   * any trade.
   *
   * @example
   * ```ts
   * const { status } = await manager.watchSession(sessionId);
   * if (status !== 'approved') return; // abort — no solo trades
   * await executeTrade(signal);
   * ```
   */
  watchSession(sessionId: string): Promise<ConsensusSession> {
    return new Promise((resolve, reject) => {
      const poll = () => {
        const session = this.sessions.get(sessionId);
        if (!session) {
          return reject(new Error(`Session ${sessionId} not found`));
        }
        if (session.status === 'approved' || session.status === 'cancelled') {
          return resolve({ ...session });
        }
        // Re-install the hook by wrapping onSessionUpdate.
        const original = this.opts.onSessionUpdate;
        this.opts.onSessionUpdate = (updated) => {
          original(updated);
          if (updated.sessionId === sessionId &&
              (updated.status === 'approved' || updated.status === 'cancelled')) {
            this.opts.onSessionUpdate = original;
            resolve({ ...updated });
          }
        };
      };
      poll();
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Remove a session from memory after it has been acted upon.
   * Call this once the trade outcome (executed or cancelled) has been recorded.
   */
  pruneSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
  }

  /** Cancel all pending sessions and clear all timers (e.g. on shutdown). */
  shutdown(): void {
    for (const [id, session] of this.sessions.entries()) {
      if (session.status === 'pending') {
        this._resolve(session, 'cancelled', 'manager shutdown');
      }
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
    }
    this.timers.clear();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _resolve(
    session: ConsensusSession,
    status: 'approved' | 'cancelled',
    cancelReason?: string,
  ): void {
    session.status = status;
    session.resolvedAt = new Date().toISOString();
    if (cancelReason) session.cancelReason = cancelReason;

    // Disarm the timeout timer.
    const timer = this.timers.get(session.sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(session.sessionId);
    }

    this.opts.onSessionUpdate({ ...session });
  }

  private _expire(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status === 'pending') {
      this._resolve(session, 'cancelled', reason);
    }
    this.timers.delete(sessionId);
  }
}

// ── Standalone Helpers ───────────────────────────────────────────────────────

/**
 * Build a ConsensusVote ready to submit.
 *
 * Agents call this locally before sending the vote to the consensus manager.
 *
 * @param sessionId - Returned by proposeConsensus()
 * @param nonce     - Returned by proposeConsensus()
 * @param agentId   - Unique identifier for this agent (e.g. "icp-agent-1")
 * @param chain     - The chain this agent runs on
 * @param approve   - true to approve, false to veto
 * @param agentSecret - The agent's signing secret
 */
export function buildVote(
  sessionId: string,
  nonce: string,
  agentId: string,
  chain: AgentChain,
  approve: boolean,
  agentSecret: Buffer,
): ConsensusVote {
  return {
    agentId,
    chain,
    nonce,
    approve,
    signature: signVote(sessionId, nonce, agentId, approve, agentSecret),
    votedAt: new Date().toISOString(),
  };
}
