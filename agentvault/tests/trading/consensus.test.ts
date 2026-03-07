/**
 * Multi-Agent Trade Consensus Tests
 *
 * Covers:
 *   - Happy path: 2-of-2 approval within 30s → approved
 *   - Timeout: no second vote arrives → cancelled
 *   - Veto: one agent rejects → cancelled immediately
 *   - Replay attack: stale/mismatched nonce → rejected
 *   - Double-vote: same agent votes twice → rejected
 *   - Unknown agent: unregistered agentId → rejected
 *   - Bad signature: tampered signature → rejected
 *   - Solo trade prevention: unilateral execution impossible
 *   - Helper: buildVote produces a verifiable signature
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  TradeConsensusManager,
  buildVote,
  signVote,
  verifyVote,
  CONSENSUS_TIMEOUT_MS,
  REQUIRED_VOTES,
} from '../../src/trading/consensus.js';
import type {
  TradeSignal,
  ConsensusVote,
} from '../../src/trading/consensus.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ICP_AGENT_ID = 'icp-agent-1';
const SOL_AGENT_ID = 'sol-agent-1';

const icpSecret = crypto.randomBytes(32);
const solSecret = crypto.randomBytes(32);

function makeManager(overrides?: { timeoutMs?: number }): TradeConsensusManager {
  return new TradeConsensusManager({
    agentSecrets: new Map([
      [ICP_AGENT_ID, icpSecret],
      [SOL_AGENT_ID, solSecret],
    ]),
    timeoutMs: overrides?.timeoutMs ?? 5_000, // short timeout in tests
  });
}

function makeSignal(overrides?: Partial<TradeSignal>): TradeSignal {
  return {
    pair: 'SOL/USDC',
    direction: 'buy',
    quantity: '10.0',
    chain: 'icp',
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── signVote / verifyVote unit tests ─────────────────────────────────────────

describe('signVote / verifyVote', () => {
  const sessionId = 'cs_test_abc123';
  const nonce = crypto.randomBytes(16).toString('hex');
  const agentId = 'test-agent';
  const secret = crypto.randomBytes(32);

  it('produces a 64-char hex HMAC-SHA256 signature', () => {
    const sig = signVote(sessionId, nonce, agentId, true, secret);
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });

  it('verifies a valid vote', () => {
    const sig = signVote(sessionId, nonce, agentId, true, secret);
    const vote: ConsensusVote = {
      agentId,
      chain: 'icp',
      signature: sig,
      nonce,
      approve: true,
      votedAt: new Date().toISOString(),
    };
    expect(verifyVote(vote, sessionId, secret)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const sig = signVote(sessionId, nonce, agentId, true, secret);
    const tampered = sig.replace(/[0-9a-f]/, (c) => ((parseInt(c, 16) + 1) % 16).toString(16));
    const vote: ConsensusVote = {
      agentId,
      chain: 'icp',
      signature: tampered,
      nonce,
      approve: true,
      votedAt: new Date().toISOString(),
    };
    expect(verifyVote(vote, sessionId, secret)).toBe(false);
  });

  it('rejects a vote signed with the wrong key', () => {
    const wrongSecret = crypto.randomBytes(32);
    const sig = signVote(sessionId, nonce, agentId, true, wrongSecret);
    const vote: ConsensusVote = {
      agentId,
      chain: 'icp',
      signature: sig,
      nonce,
      approve: true,
      votedAt: new Date().toISOString(),
    };
    expect(verifyVote(vote, sessionId, secret)).toBe(false);
  });

  it('different approve/veto produces different signatures', () => {
    const approve = signVote(sessionId, nonce, agentId, true, secret);
    const veto = signVote(sessionId, nonce, agentId, false, secret);
    expect(approve).not.toBe(veto);
  });
});

// ── buildVote helper ──────────────────────────────────────────────────────────

describe('buildVote', () => {
  it('builds a vote that passes verifyVote', () => {
    const sessionId = 'cs_build_test';
    const nonce = crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(32);
    const vote = buildVote(sessionId, nonce, 'agent-x', 'solana', true, secret);
    expect(verifyVote(vote, sessionId, secret)).toBe(true);
  });
});

// ── TradeConsensusManager ─────────────────────────────────────────────────────

describe('TradeConsensusManager', () => {
  let manager: TradeConsensusManager;

  beforeEach(() => {
    manager = makeManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('happy path: 2-of-2 approval', () => {
    it('reaches approved status after both agents vote', () => {
      const signal = makeSignal();
      const session = manager.proposeConsensus(signal);
      expect(session.status).toBe('pending');

      const icpVote = buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', true, icpSecret);
      const afterIcp = manager.castVote(session.sessionId, icpVote);
      expect(afterIcp.status).toBe('pending'); // still needs second vote

      const solVote = buildVote(session.sessionId, session.nonce, SOL_AGENT_ID, 'solana', true, solSecret);
      const afterSol = manager.castVote(session.sessionId, solVote);
      expect(afterSol.status).toBe('approved');
      expect(afterSol.votes).toHaveLength(2);
      expect(afterSol.resolvedAt).toBeDefined();
    });

    it('records both votes in approved session', () => {
      const session = manager.proposeConsensus(makeSignal());
      manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', true, icpSecret));
      const result = manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, SOL_AGENT_ID, 'solana', true, solSecret));
      const agentIds = result.votes.map((v) => v.agentId);
      expect(agentIds).toContain(ICP_AGENT_ID);
      expect(agentIds).toContain(SOL_AGENT_ID);
    });

    it('watchSession resolves with approved status', async () => {
      const session = manager.proposeConsensus(makeSignal());
      const watchPromise = manager.watchSession(session.sessionId);

      // Cast both votes synchronously
      manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', true, icpSecret));
      manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, SOL_AGENT_ID, 'solana', true, solSecret));

      const result = await watchPromise;
      expect(result.status).toBe('approved');
    });
  });

  // ── Timeout ────────────────────────────────────────────────────────────────

  describe('timeout: 30-second window', () => {
    it('cancels a pending session after timeout elapses', async () => {
      const shortManager = makeManager({ timeoutMs: 100 });
      vi.useRealTimers();

      const session = shortManager.proposeConsensus(makeSignal());
      // Cast only one vote
      shortManager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', true, icpSecret));

      // Wait for timeout
      await new Promise((r) => setTimeout(r, 150));

      const final = shortManager.getSession(session.sessionId);
      expect(final?.status).toBe('cancelled');
      expect(final?.cancelReason).toContain('timeout');

      shortManager.shutdown();
    });

    it('watchSession resolves with cancelled on timeout', async () => {
      const shortManager = makeManager({ timeoutMs: 100 });
      vi.useRealTimers();

      const session = shortManager.proposeConsensus(makeSignal());
      const watchPromise = shortManager.watchSession(session.sessionId);

      await new Promise((r) => setTimeout(r, 150));

      const result = await watchPromise;
      expect(result.status).toBe('cancelled');

      shortManager.shutdown();
    });

    it('CONSENSUS_TIMEOUT_MS default is 30 seconds', () => {
      expect(CONSENSUS_TIMEOUT_MS).toBe(30_000);
    });

    it('REQUIRED_VOTES is 2', () => {
      expect(REQUIRED_VOTES).toBe(2);
    });
  });

  // ── Veto ───────────────────────────────────────────────────────────────────

  describe('veto: immediate cancellation', () => {
    it('cancels on first veto without waiting for timeout', () => {
      const session = manager.proposeConsensus(makeSignal());
      const vetoVote = buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', false, icpSecret);
      const result = manager.castVote(session.sessionId, vetoVote);
      expect(result.status).toBe('cancelled');
      expect(result.cancelReason).toContain(ICP_AGENT_ID);
    });

    it('refuses further votes after veto', () => {
      const session = manager.proposeConsensus(makeSignal());
      manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', false, icpSecret));
      expect(() =>
        manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, SOL_AGENT_ID, 'solana', true, solSecret))
      ).toThrow('cancelled');
    });
  });

  // ── Security: replay attack ────────────────────────────────────────────────

  describe('replay attack prevention', () => {
    it('rejects a vote with a stale (wrong) nonce', () => {
      const session = manager.proposeConsensus(makeSignal());
      const staleNonce = crypto.randomBytes(16).toString('hex');
      const sig = signVote(session.sessionId, staleNonce, ICP_AGENT_ID, true, icpSecret);
      const vote: ConsensusVote = {
        agentId: ICP_AGENT_ID,
        chain: 'icp',
        signature: sig,
        nonce: staleNonce, // wrong nonce
        approve: true,
        votedAt: new Date().toISOString(),
      };
      expect(() => manager.castVote(session.sessionId, vote)).toThrow('nonce mismatch');
    });
  });

  // ── Security: double-vote ─────────────────────────────────────────────────

  describe('double-vote prevention', () => {
    it('rejects a second vote from the same agent', () => {
      const session = manager.proposeConsensus(makeSignal());
      manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', true, icpSecret));
      expect(() =>
        manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', true, icpSecret))
      ).toThrow('already voted');
    });
  });

  // ── Security: unknown agent ────────────────────────────────────────────────

  describe('unknown agent rejection', () => {
    it('rejects a vote from an unregistered agent', () => {
      const rogue = 'rogue-agent';
      const rogueSecret = crypto.randomBytes(32);
      const session = manager.proposeConsensus(makeSignal());
      const vote = buildVote(session.sessionId, session.nonce, rogue, 'solana', true, rogueSecret);
      expect(() => manager.castVote(session.sessionId, vote)).toThrow('Unknown agentId');
    });
  });

  // ── Security: bad signature ────────────────────────────────────────────────

  describe('bad signature rejection', () => {
    it('rejects a vote whose signature does not verify', () => {
      const session = manager.proposeConsensus(makeSignal());
      const vote: ConsensusVote = {
        agentId: ICP_AGENT_ID,
        chain: 'icp',
        signature: '00'.repeat(32), // 64 hex chars but wrong HMAC
        nonce: session.nonce,
        approve: true,
        votedAt: new Date().toISOString(),
      };
      expect(() => manager.castVote(session.sessionId, vote)).toThrow('Invalid vote signature');
    });
  });

  // ── Solo trade prevention ─────────────────────────────────────────────────

  describe('solo trade prevention', () => {
    it('session stays pending after only one approval — trade must NOT fire', () => {
      const session = manager.proposeConsensus(makeSignal());
      const result = manager.castVote(
        session.sessionId,
        buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', true, icpSecret),
      );
      // Only one vote — must remain pending, never approved
      expect(result.status).toBe('pending');
      expect(result.status).not.toBe('approved');
    });

    it('getSession returns pending with one vote — caller must not execute', () => {
      const session = manager.proposeConsensus(makeSignal());
      manager.castVote(
        session.sessionId,
        buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', true, icpSecret),
      );
      const snap = manager.getSession(session.sessionId);
      expect(snap?.status).not.toBe('approved');
    });
  });

  // ── Session not found ──────────────────────────────────────────────────────

  describe('session management', () => {
    it('throws when casting vote on unknown session', () => {
      const vote = buildVote('nonexistent', 'fake-nonce', ICP_AGENT_ID, 'icp', true, icpSecret);
      expect(() => manager.castVote('nonexistent', vote)).toThrow('not found');
    });

    it('returns undefined for unknown session from getSession', () => {
      expect(manager.getSession('no-such-id')).toBeUndefined();
    });

    it('listSessions returns only sessions matching the filter', () => {
      const s1 = manager.proposeConsensus(makeSignal());
      const s2 = manager.proposeConsensus(makeSignal({ pair: 'ETH/USDC' }));

      manager.castVote(s1.sessionId, buildVote(s1.sessionId, s1.nonce, ICP_AGENT_ID, 'icp', true, icpSecret));
      manager.castVote(s1.sessionId, buildVote(s1.sessionId, s1.nonce, SOL_AGENT_ID, 'solana', true, solSecret));

      expect(manager.listSessions('approved')).toHaveLength(1);
      expect(manager.listSessions('pending')).toHaveLength(1);
      expect(manager.listSessions('cancelled')).toHaveLength(0);

      // s2 unused — suppress timeout warning
      manager.pruneSession(s2.sessionId);
    });

    it('pruneSession removes the session from memory', () => {
      const session = manager.proposeConsensus(makeSignal());
      manager.pruneSession(session.sessionId);
      expect(manager.getSession(session.sessionId)).toBeUndefined();
    });
  });

  // ── Already-resolved session ───────────────────────────────────────────────

  describe('resolved session', () => {
    it('throws when casting vote on approved session', () => {
      const session = manager.proposeConsensus(makeSignal());
      manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, ICP_AGENT_ID, 'icp', true, icpSecret));
      manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, SOL_AGENT_ID, 'solana', true, solSecret));
      // Try a third vote — impossible in practice but must be safe
      expect(() =>
        manager.castVote(session.sessionId, buildVote(session.sessionId, session.nonce, SOL_AGENT_ID, 'solana', true, solSecret))
      ).toThrow('approved');
    });
  });
});
