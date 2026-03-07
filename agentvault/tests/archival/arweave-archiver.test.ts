/**
 * Tests for Arweave Archival with Wallet Signing
 *
 * BDD scenarios:
 *
 *  Scenario 1 – Bundle creation & upload
 *    Given current agent state and manifest
 *    When  the heartbeat triggers archival
 *    Then  the bundle is signed with the deployed wallet
 *    And   uploaded to Arweave
 *
 *  Scenario 2 – Auto-archive on state change
 *    Given any state mutation
 *    When  the next heartbeat fires
 *    Then  an updated bundle is automatically created and uploaded
 *
 *  Scenario 3 – Retrieval & verification
 *    Given a bundle ID
 *    When  the bundle is fetched from Arweave
 *    Then  the signature verifies against the wallet
 *    And   the manifest matches the stored state hash
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import {
  ArweaveArchiver,
  type ArweaveBundle,
  type ArchiveResult,
} from '../../src/archival/arweave-archiver.js';
import type { JWKInterface } from '../../src/archival/arweave-client.js';

// ── Fixtures & helpers ────────────────────────────────────────────────────────

const STUB_JWK: JWKInterface = { kty: 'RSA', stub: true };
const AGENT_STATE = { counter: 42, memory: ['remember this'], status: 'active' };

/** Build an ArweaveArchiver backed by a stub Arweave client (no real network). */
function makeArchiver(
  agentName: string,
  keyPath: string,
  uploadResult?: Partial<{ success: boolean; transactionId: string; error: string }>,
  fetchData?: string | null,
) {
  const txId = `mock-tx-${crypto.randomBytes(4).toString('hex')}`;

  const stubClient = {
    uploadJSON: vi.fn().mockResolvedValue({
      success: true,
      transactionId: txId,
      ...uploadResult,
    }),
    getTransactionData: vi.fn().mockResolvedValue(fetchData ?? null),
  };

  const archiver = new ArweaveArchiver({
    agentName,
    signingKeyPath: keyPath,
    client: stubClient as any,
  });

  return { archiver, stubClient, txId };
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;
let keyPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-archiver-'));
  keyPath = path.join(tmpDir, 'signing.key');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

// ── Scenario 1: Bundle creation & upload ─────────────────────────────────────

describe('Scenario 1 – Bundle creation & upload', () => {
  describe('createBundle', () => {
    it('returns a bundle with the correct format identifier', async () => {
      const { archiver } = makeArchiver('agent-x', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      expect(bundle.format).toBe('agentvault-arweave-bundle-v1');
    });

    it('manifest.agentName matches the archiver name', async () => {
      const { archiver } = makeArchiver('my-agent', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      expect(bundle.manifest.agentName).toBe('my-agent');
    });

    it('manifest.version is "1.0"', async () => {
      const { archiver } = makeArchiver('agent-v', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      expect(bundle.manifest.version).toBe('1.0');
    });

    it('manifest.timestamp is a valid ISO-8601 string', async () => {
      const { archiver } = makeArchiver('agent-ts', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      expect(() => new Date(bundle.manifest.timestamp)).not.toThrow();
      expect(new Date(bundle.manifest.timestamp).toISOString()).toBe(bundle.manifest.timestamp);
    });

    it('manifest.stateHash is a 64-char SHA-256 hex', async () => {
      const { archiver } = makeArchiver('agent-h', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      expect(bundle.manifest.stateHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('manifest.stateHash equals SHA-256 of bundle.state', async () => {
      const { archiver } = makeArchiver('agent-sh', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const expected = crypto
        .createHash('sha256')
        .update(bundle.state)
        .digest('hex');
      expect(bundle.manifest.stateHash).toBe(expected);
    });

    it('manifest.merkleRoot is a 64-char SHA-256 hex', async () => {
      const { archiver } = makeArchiver('agent-mr', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      expect(bundle.manifest.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    });

    it('manifest.publicKey is a 64-char ed25519 public key hex', async () => {
      const { archiver } = makeArchiver('agent-pk', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      expect(bundle.manifest.publicKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('signature is a 128-char ed25519 signature hex', async () => {
      const { archiver } = makeArchiver('agent-sig', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      expect(bundle.signature).toMatch(/^[0-9a-f]{128}$/);
    });

    it('bundle.state is the JSON-serialised state', async () => {
      const { archiver } = makeArchiver('agent-state', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      expect(JSON.parse(bundle.state)).toEqual(AGENT_STATE);
    });

    it('reuses the same signing key across calls (same publicKey)', async () => {
      const { archiver } = makeArchiver('agent-reuse', keyPath);
      const b1 = await archiver.createBundle(AGENT_STATE);
      const b2 = await archiver.createBundle({ counter: 99 });
      expect(b1.manifest.publicKey).toBe(b2.manifest.publicKey);
    });

    it('different states produce different stateHashes', async () => {
      const { archiver } = makeArchiver('agent-diff', keyPath);
      const b1 = await archiver.createBundle({ x: 1 });
      const b2 = await archiver.createBundle({ x: 2 });
      expect(b1.manifest.stateHash).not.toBe(b2.manifest.stateHash);
    });
  });

  describe('uploadBundle', () => {
    it('calls uploadJSON on the Arweave client with the bundle', async () => {
      const { archiver, stubClient } = makeArchiver('agent-up', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      await archiver.uploadBundle(bundle, STUB_JWK);
      expect(stubClient.uploadJSON).toHaveBeenCalledOnce();
      const [passedBundle] = stubClient.uploadJSON.mock.calls[0] as [ArweaveBundle];
      expect(passedBundle.format).toBe('agentvault-arweave-bundle-v1');
    });

    it('returns the Arweave transaction ID as bundleId', async () => {
      const { archiver, txId } = makeArchiver('agent-txid', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const result = await archiver.uploadBundle(bundle, STUB_JWK);
      expect(result.success).toBe(true);
      expect(result.bundleId).toBe(txId);
      expect(result.transactionId).toBe(txId);
    });

    it('returns stateHash and publicKey in the upload result', async () => {
      const { archiver } = makeArchiver('agent-meta', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const result = await archiver.uploadBundle(bundle, STUB_JWK);
      expect(result.stateHash).toBe(bundle.manifest.stateHash);
      expect(result.publicKey).toBe(bundle.manifest.publicKey);
    });

    it('returns success:false when the client reports an error', async () => {
      const { archiver } = makeArchiver('agent-err', keyPath, {
        success: false,
        error: 'network timeout',
      });
      const bundle = await archiver.createBundle(AGENT_STATE);
      const result = await archiver.uploadBundle(bundle, STUB_JWK);
      expect(result.success).toBe(false);
      expect(result.error).toContain('network timeout');
    });

    it('tags include App-Name, Agent-Name, Bundle-Format, State-Hash, Public-Key', async () => {
      const { archiver, stubClient } = makeArchiver('tag-agent', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      await archiver.uploadBundle(bundle, STUB_JWK);

      const [, , opts] = stubClient.uploadJSON.mock.calls[0] as [unknown, unknown, { tags: Record<string, string> }];
      expect(opts.tags['App-Name']).toBe('AgentVault');
      expect(opts.tags['Agent-Name']).toBe('tag-agent');
      expect(opts.tags['Bundle-Format']).toBe('agentvault-arweave-bundle-v1');
      expect(opts.tags['State-Hash']).toBe(bundle.manifest.stateHash);
      expect(opts.tags['Public-Key']).toBe(bundle.manifest.publicKey);
    });
  });

  describe('archive (create + upload in one call)', () => {
    it('creates a bundle and uploads it, returning bundleId', async () => {
      const { archiver, txId } = makeArchiver('agent-arc', keyPath);
      const result = await archiver.archive(AGENT_STATE, STUB_JWK);
      expect(result.success).toBe(true);
      expect(result.bundleId).toBe(txId);
    });

    it('clears the dirty flag after a successful archive', async () => {
      const { archiver } = makeArchiver('agent-dirty', keyPath);
      archiver.setState(AGENT_STATE);
      expect(archiver.isDirty).toBe(true);

      await archiver.archive(AGENT_STATE, STUB_JWK);
      expect(archiver.isDirty).toBe(false);
    });

    it('keeps dirty flag when upload fails', async () => {
      const { archiver } = makeArchiver('agent-fail', keyPath, {
        success: false,
        error: 'upload error',
      });
      archiver.setState(AGENT_STATE);
      await archiver.archive(AGENT_STATE, STUB_JWK);
      expect(archiver.isDirty).toBe(true);
    });
  });
});

// ── Scenario 2: Auto-archive on state change ──────────────────────────────────

describe('Scenario 2 – Auto-archive on state change', () => {
  describe('isDirty flag', () => {
    it('is false before any state is set', () => {
      const { archiver } = makeArchiver('clean', keyPath);
      expect(archiver.isDirty).toBe(false);
    });

    it('becomes true after setState', () => {
      const { archiver } = makeArchiver('dirt', keyPath);
      archiver.setState(AGENT_STATE);
      expect(archiver.isDirty).toBe(true);
    });

    it('is false after the same state is archived and not changed', async () => {
      const { archiver } = makeArchiver('post-arc', keyPath);
      archiver.setState(AGENT_STATE);
      await archiver.archive(AGENT_STATE, STUB_JWK);
      expect(archiver.isDirty).toBe(false);
    });

    it('becomes true again when state is mutated after archival', async () => {
      const { archiver } = makeArchiver('remutate', keyPath);
      archiver.setState(AGENT_STATE);
      await archiver.archive(AGENT_STATE, STUB_JWK);
      archiver.setState({ ...AGENT_STATE, counter: 43 });
      expect(archiver.isDirty).toBe(true);
    });

    it('remains false when same-content state is re-set after archival', async () => {
      const { archiver } = makeArchiver('same-state', keyPath);
      archiver.setState(AGENT_STATE);
      await archiver.archive(AGENT_STATE, STUB_JWK);
      archiver.setState({ ...AGENT_STATE }); // same content, new object
      expect(archiver.isDirty).toBe(false);
    });
  });

  describe('heartbeat: auto-archives dirty state', () => {
    it('fires archival when state is dirty', async () => {
      vi.useFakeTimers();
      const { archiver, stubClient } = makeArchiver('hb-dirty', keyPath);

      archiver.setState(AGENT_STATE);
      archiver.startHeartbeat({ intervalMs: 1_000, jwk: STUB_JWK });

      await vi.advanceTimersByTimeAsync(1_100);

      expect(stubClient.uploadJSON).toHaveBeenCalledOnce();
      archiver.stopHeartbeat();
    });

    it('does NOT fire archival when state is clean', async () => {
      vi.useFakeTimers();
      const { archiver, stubClient } = makeArchiver('hb-clean', keyPath);

      // No setState → isDirty is false
      archiver.startHeartbeat({ intervalMs: 1_000, jwk: STUB_JWK });

      await vi.advanceTimersByTimeAsync(3_100);

      expect(stubClient.uploadJSON).not.toHaveBeenCalled();
      archiver.stopHeartbeat();
    });

    it('calls onArchived callback after successful upload', async () => {
      vi.useFakeTimers();
      const { archiver } = makeArchiver('hb-cb', keyPath);
      const onArchived = vi.fn<(result: ArchiveResult) => void>();

      archiver.setState(AGENT_STATE);
      archiver.startHeartbeat({ intervalMs: 500, jwk: STUB_JWK, onArchived });

      await vi.advanceTimersByTimeAsync(600);

      expect(onArchived).toHaveBeenCalledOnce();
      const callArgs = onArchived.mock.calls[0];
      const result = callArgs?.[0];
      expect(result?.success).toBe(true);
      archiver.stopHeartbeat();
    });

    it('calls onError callback when upload fails', async () => {
      vi.useFakeTimers();
      const { archiver } = makeArchiver('hb-err', keyPath, {
        success: false,
        error: 'gateway error',
      });
      const onError = vi.fn<(error: Error) => void>();

      archiver.setState(AGENT_STATE);
      archiver.startHeartbeat({ intervalMs: 500, jwk: STUB_JWK, onError });

      await vi.advanceTimersByTimeAsync(600);

      expect(onError).toHaveBeenCalledOnce();
      archiver.stopHeartbeat();
    });

    it('archives once per dirty state, not on every tick when clean', async () => {
      vi.useFakeTimers();
      const { archiver, stubClient } = makeArchiver('hb-once', keyPath);

      archiver.setState(AGENT_STATE);
      archiver.startHeartbeat({ intervalMs: 500, jwk: STUB_JWK });

      // First tick archives dirty state
      await vi.advanceTimersByTimeAsync(600);
      // Second + third ticks should be no-ops (clean)
      await vi.advanceTimersByTimeAsync(1_100);

      expect(stubClient.uploadJSON).toHaveBeenCalledOnce();
      archiver.stopHeartbeat();
    });

    it('archives again when state changes after previous archival', async () => {
      vi.useFakeTimers();
      const { archiver, stubClient } = makeArchiver('hb-twice', keyPath);

      archiver.setState({ counter: 1 });
      archiver.startHeartbeat({ intervalMs: 500, jwk: STUB_JWK });

      await vi.advanceTimersByTimeAsync(600);  // archives counter:1
      archiver.setState({ counter: 2 });        // new mutation → dirty again
      await vi.advanceTimersByTimeAsync(600);  // archives counter:2

      expect(stubClient.uploadJSON).toHaveBeenCalledTimes(2);
      archiver.stopHeartbeat();
    });

    it('stopHeartbeat prevents further archival', async () => {
      vi.useFakeTimers();
      const { archiver, stubClient } = makeArchiver('hb-stop', keyPath);

      archiver.setState(AGENT_STATE);
      archiver.startHeartbeat({ intervalMs: 500, jwk: STUB_JWK });
      archiver.stopHeartbeat();

      // Advance past where ticks would have fired
      await vi.advanceTimersByTimeAsync(2_000);

      expect(stubClient.uploadJSON).not.toHaveBeenCalled();
    });

    it('stopHeartbeat is safe to call when heartbeat is not running', () => {
      const { archiver } = makeArchiver('hb-nostopp', keyPath);
      expect(() => archiver.stopHeartbeat()).not.toThrow();
    });

    it('throws when startHeartbeat is called a second time', () => {
      const { archiver } = makeArchiver('hb-double', keyPath);
      archiver.startHeartbeat({ intervalMs: 60_000, jwk: STUB_JWK });
      expect(() =>
        archiver.startHeartbeat({ intervalMs: 60_000, jwk: STUB_JWK }),
      ).toThrow('Heartbeat already running');
      archiver.stopHeartbeat();
    });

    it('can restart heartbeat after stop', () => {
      vi.useFakeTimers();
      const { archiver } = makeArchiver('hb-restart', keyPath);
      archiver.startHeartbeat({ intervalMs: 60_000, jwk: STUB_JWK });
      archiver.stopHeartbeat();
      expect(() =>
        archiver.startHeartbeat({ intervalMs: 60_000, jwk: STUB_JWK }),
      ).not.toThrow();
      archiver.stopHeartbeat();
    });
  });
});

// ── Scenario 3: Retrieval & verification ─────────────────────────────────────

describe('Scenario 3 – Retrieval & verification', () => {
  describe('verifyBundle: valid bundle', () => {
    it('returns valid:true for a freshly created bundle', async () => {
      const { archiver } = makeArchiver('verify-ok', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const result = await archiver.verifyBundle(bundle);
      expect(result.valid).toBe(true);
    });

    it('stateHashMatch is true for an untampered bundle', async () => {
      const { archiver } = makeArchiver('v-hash', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const result = await archiver.verifyBundle(bundle);
      expect(result.stateHashMatch).toBe(true);
    });

    it('signatureValid is true for an untampered bundle', async () => {
      const { archiver } = makeArchiver('v-sig', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const result = await archiver.verifyBundle(bundle);
      expect(result.signatureValid).toBe(true);
    });

    it('publicKeyMatch is true when expectedPublicKey matches manifest.publicKey', async () => {
      const { archiver } = makeArchiver('v-pk', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const result = await archiver.verifyBundle(bundle, bundle.manifest.publicKey);
      expect(result.publicKeyMatch).toBe(true);
      expect(result.valid).toBe(true);
    });

    it('publicKeyMatch defaults to true when no expectedPublicKey is supplied', async () => {
      const { archiver } = makeArchiver('v-nopk', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const result = await archiver.verifyBundle(bundle);
      expect(result.publicKeyMatch).toBe(true);
    });

    it('getPublicKey() returns the same key embedded in bundles', async () => {
      const { archiver } = makeArchiver('v-getpk', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const walletKey = await archiver.getPublicKey();
      expect(walletKey).toBe(bundle.manifest.publicKey);
    });

    it('verifyBundle with getPublicKey() returns valid:true', async () => {
      const { archiver } = makeArchiver('v-round', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const walletKey = await archiver.getPublicKey();
      const result = await archiver.verifyBundle(bundle, walletKey!);
      expect(result.valid).toBe(true);
    });
  });

  describe('verifyBundle: tampered state', () => {
    it('stateHashMatch is false when state is modified after signing', async () => {
      const { archiver } = makeArchiver('v-tampered-state', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);

      const tampered: ArweaveBundle = {
        ...bundle,
        state: JSON.stringify({ ...AGENT_STATE, counter: 999 }),
      };

      const result = await archiver.verifyBundle(tampered);
      expect(result.stateHashMatch).toBe(false);
      expect(result.valid).toBe(false);
    });

    it('stateHashMatch is false when stateHash in manifest is tampered', async () => {
      const { archiver } = makeArchiver('v-tampered-hash', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);

      const tampered: ArweaveBundle = {
        ...bundle,
        manifest: {
          ...bundle.manifest,
          stateHash: 'a'.repeat(64),
        },
      };

      const result = await archiver.verifyBundle(tampered);
      expect(result.stateHashMatch).toBe(false);
    });
  });

  describe('verifyBundle: tampered signature', () => {
    it('signatureValid is false when the signature is corrupted', async () => {
      const { archiver } = makeArchiver('v-bad-sig', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);

      // Flip the first byte of the signature
      const sigBytes = Buffer.from(bundle.signature, 'hex');
      sigBytes[0] = (sigBytes[0]! ^ 0xff);
      const tampered: ArweaveBundle = {
        ...bundle,
        signature: sigBytes.toString('hex'),
      };

      const result = await archiver.verifyBundle(tampered);
      expect(result.signatureValid).toBe(false);
      expect(result.valid).toBe(false);
    });

    it('signatureValid is false when manifest fields are changed after signing', async () => {
      const { archiver } = makeArchiver('v-man-tamper', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);

      // Change agentName in manifest without re-signing
      const tampered: ArweaveBundle = {
        ...bundle,
        manifest: { ...bundle.manifest, agentName: 'impersonator' },
      };

      const result = await archiver.verifyBundle(tampered);
      expect(result.signatureValid).toBe(false);
    });
  });

  describe('verifyBundle: wrong wallet (public key mismatch)', () => {
    it('publicKeyMatch is false when expectedPublicKey does not match', async () => {
      const { archiver } = makeArchiver('v-wrong-wallet', keyPath);
      const bundle = await archiver.createBundle(AGENT_STATE);
      const wrongKey = crypto.randomBytes(32).toString('hex'); // random 32-byte key
      const result = await archiver.verifyBundle(bundle, wrongKey);
      expect(result.publicKeyMatch).toBe(false);
      expect(result.valid).toBe(false);
    });

    it('signatureValid is false when a bundle signed by a different key is checked', async () => {
      // Create two archivers with different signing keys
      const keyPath1 = path.join(tmpDir, 'key1.key');
      const keyPath2 = path.join(tmpDir, 'key2.key');

      const { archiver: archiver1 } = makeArchiver('wallet-a', keyPath1);
      const { archiver: archiver2 } = makeArchiver('wallet-b', keyPath2);

      const bundleFromA = await archiver1.createBundle(AGENT_STATE);
      // Force key generation for archiver2 so getPublicKey() returns a real key
      await archiver2.createBundle({ dummy: true });
      const walletBKey = await archiver2.getPublicKey();

      // Bundle signed by wallet A should NOT match wallet B's public key
      const result = await archiver2.verifyBundle(bundleFromA, walletBKey!);
      // publicKeyMatch is false because keys differ
      expect(result.publicKeyMatch).toBe(false);
      expect(result.valid).toBe(false);
    });
  });

  describe('fetchBundle', () => {
    it('returns null when the Arweave client returns no data', async () => {
      const { archiver } = makeArchiver('fb-null', keyPath, undefined, null);
      const result = await archiver.fetchBundle('some-tx-id');
      expect(result).toBeNull();
    });

    it('returns null when the data is not a valid bundle format', async () => {
      const { archiver } = makeArchiver('fb-invalid', keyPath, undefined, '{}');
      const result = await archiver.fetchBundle('bad-tx');
      expect(result).toBeNull();
    });

    it('returns the parsed bundle when valid JSON is returned', async () => {
      const { archiver } = makeArchiver('fb-ok', keyPath);
      const original = await archiver.createBundle(AGENT_STATE);
      const fetched_archiver = new ArweaveArchiver({
        agentName: 'fb-ok',
        signingKeyPath: keyPath,
        client: {
          uploadJSON: vi.fn(),
          getTransactionData: vi.fn().mockResolvedValue(JSON.stringify(original)),
        } as any,
      });

      const fetched = await fetched_archiver.fetchBundle('real-tx-id');
      expect(fetched).not.toBeNull();
      expect(fetched?.format).toBe('agentvault-arweave-bundle-v1');
      expect(fetched?.manifest.agentName).toBe('fb-ok');
    });

    it('fetched bundle passes verifyBundle', async () => {
      const bundle = await (async () => {
        const { archiver } = makeArchiver('fb-verify', keyPath);
        return archiver.createBundle(AGENT_STATE);
      })();

      const fetchArchiver = new ArweaveArchiver({
        agentName: 'fb-verify',
        signingKeyPath: keyPath,
        client: {
          uploadJSON: vi.fn(),
          getTransactionData: vi.fn().mockResolvedValue(JSON.stringify(bundle)),
        } as any,
      });

      const fetched = await fetchArchiver.fetchBundle('tx-abc');
      expect(fetched).not.toBeNull();

      const verification = await fetchArchiver.verifyBundle(fetched!);
      expect(verification.valid).toBe(true);
    });
  });

  describe('getPublicKey', () => {
    it('returns null when the key file does not exist', async () => {
      const { archiver } = makeArchiver('pk-none', path.join(tmpDir, 'nonexistent.key'));
      const key = await archiver.getPublicKey();
      expect(key).toBeNull();
    });

    it('returns a 64-char hex string after a bundle has been created', async () => {
      const { archiver } = makeArchiver('pk-exists', keyPath);
      await archiver.createBundle(AGENT_STATE); // creates the key file
      const key = await archiver.getPublicKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the same key across multiple calls', async () => {
      const { archiver } = makeArchiver('pk-stable', keyPath);
      await archiver.createBundle(AGENT_STATE);
      const k1 = await archiver.getPublicKey();
      const k2 = await archiver.getPublicKey();
      expect(k1).toBe(k2);
    });
  });
});
