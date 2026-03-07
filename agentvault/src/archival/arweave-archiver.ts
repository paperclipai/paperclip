/**
 * Arweave Archiver
 *
 * Provides permanent, cryptographically-signed archival of agent state to Arweave.
 *
 * Features:
 *  - Bundle creation: agent state + manifest, signed with the deployed ed25519 wallet
 *  - Heartbeat-triggered archival: automatically uploads on state change
 *  - Retrieval & verification: fetch bundle by ID, verify signature against wallet
 *
 * Bundle format: agentvault-arweave-bundle-v1
 *   { format, manifest, signature, state }
 *   where signature = ed25519.sign(canonicalManifestBytes(manifest), privateKey)
 *   and   manifest.stateHash = SHA-256(state JSON)
 *   and   manifest.merkleRoot = Merkle root of [{ path:'state.json', content:stateBytes }]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { ArweaveClient, type ArweaveConfig, type JWKInterface } from './arweave-client.js';
import { computeMerkleRoot, type MerkleEntry } from '../backup/merkle.js';
import { loadOrCreateSigningKey } from '../backup/backup.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ArweaveBundleManifest {
  /** Schema version */
  version: string;
  /** Name of the agent whose state is archived */
  agentName: string;
  /** ISO-8601 creation timestamp */
  timestamp: string;
  /** SHA-256 hex of the serialised agent state */
  stateHash: string;
  /** SHA-256 Merkle root of the bundle entries (currently just state.json) */
  merkleRoot: string;
  /** ed25519 public key (64-char hex = 32 bytes) used to create the signature */
  publicKey: string;
}

export interface ArweaveBundle {
  format: 'agentvault-arweave-bundle-v1';
  manifest: ArweaveBundleManifest;
  /**
   * ed25519 signature (128-char hex = 64 bytes) over
   * canonicalManifestBytes(manifest).
   */
  signature: string;
  /** JSON-serialised agent state */
  state: string;
}

export interface ArchiverOptions {
  /** Agent identifier embedded in every bundle manifest. */
  agentName: string;
  /**
   * Path to the 32-byte ed25519 private key (stored as 64 hex chars).
   * Defaults to ~/.agentvault/arweave-signing.key.
   * Created automatically if the file does not exist.
   */
  signingKeyPath?: string;
  /** Arweave gateway configuration passed through to ArweaveClient. */
  arweaveConfig?: ArweaveConfig;
  /**
   * @internal For testing only.
   * Override the ArweaveClient instance instead of creating a new one.
   */
  client?: ArweaveClient;
}

export interface ArchiveResult {
  success: boolean;
  /** Arweave transaction ID (= bundle retrieval ID) */
  bundleId?: string;
  /** Alias for bundleId – kept for symmetry with archive-manager types */
  transactionId?: string;
  /** SHA-256 hex of the archived state */
  stateHash?: string;
  /** ed25519 public key hex of the signing wallet */
  publicKey?: string;
  error?: string;
}

export interface HeartbeatOptions {
  /** How often (ms) the heartbeat fires.  Default: 60 000 (1 minute). */
  intervalMs?: number;
  /** Arweave JWK wallet used to pay for and sign the transaction. */
  jwk: JWKInterface;
  /** Extra Arweave tags added to every uploaded transaction. */
  tags?: Record<string, string>;
  /** Called after each successful archival. */
  onArchived?: (result: ArchiveResult) => void;
  /** Called when an archival attempt fails. */
  onError?: (error: Error) => void;
}

export interface VerifyResult {
  /** True when all three checks pass. */
  valid: boolean;
  /** state hash re-computed from bundle.state matches manifest.stateHash */
  stateHashMatch: boolean;
  /** ed25519 signature verifies against manifest.publicKey */
  signatureValid: boolean;
  /**
   * Matches expectedPublicKey when provided.
   * Always true when no expectedPublicKey is passed.
   */
  publicKeyMatch: boolean;
  error?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Produce a canonical (alphabetically-keyed) JSON Buffer of the manifest so
 * that sign and verify produce identical bytes regardless of JS object
 * insertion order.
 */
function canonicalManifestBytes(manifest: ArweaveBundleManifest): Buffer {
  const sorted: Record<string, string> = {};
  for (const key of (Object.keys(manifest) as (keyof ArweaveBundleManifest)[]).sort()) {
    sorted[key] = manifest[key];
  }
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const DEFAULT_SIGNING_KEY_FILENAME = 'arweave-signing.key';

// ── ArweaveArchiver ───────────────────────────────────────────────────────────

export class ArweaveArchiver {
  private readonly agentName: string;
  private readonly signingKeyPath: string;
  private readonly arweaveClient: ArweaveClient;

  private currentState: Record<string, unknown> | null = null;
  private lastArchivedStateHash: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ArchiverOptions) {
    this.agentName = options.agentName;
    this.signingKeyPath =
      options.signingKeyPath ??
      (() => {
        const home =
          process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
        return `${home}/.agentvault/${DEFAULT_SIGNING_KEY_FILENAME}`;
      })();
    this.arweaveClient =
      options.client ?? new ArweaveClient(options.arweaveConfig ?? {});
  }

  // ── State management ────────────────────────────────────────────────────────

  /**
   * Update the current agent state.
   * The archiver will consider itself dirty until this state is archived.
   */
  setState(state: Record<string, unknown>): void {
    this.currentState = state;
  }

  /**
   * True when the current state has changed since the last successful archive.
   */
  get isDirty(): boolean {
    if (this.currentState === null) return false;
    const hash = sha256Hex(JSON.stringify(this.currentState));
    return hash !== this.lastArchivedStateHash;
  }

  // ── Bundle creation ─────────────────────────────────────────────────────────

  /**
   * Create a signed Arweave bundle from the supplied agent state.
   *
   * Steps:
   *  1. Serialise state → stateHash (SHA-256)
   *  2. Build Merkle root of [state.json]
   *  3. Build manifest { version, agentName, timestamp, stateHash, merkleRoot, publicKey }
   *  4. Sign canonical manifest bytes with ed25519
   *  5. Return ArweaveBundle
   */
  async createBundle(state: Record<string, unknown>): Promise<ArweaveBundle> {
    const { privateKey, publicKey } = await loadOrCreateSigningKey(
      this.signingKeyPath,
    );
    const { ed25519 } = await import('@noble/curves/ed25519');

    const stateJson = JSON.stringify(state);
    const stateHash = sha256Hex(stateJson);

    const entries: MerkleEntry[] = [
      { path: 'state.json', content: Buffer.from(stateJson, 'utf8') },
    ];
    const merkleRoot = computeMerkleRoot(entries);

    const manifest: ArweaveBundleManifest = {
      version: '1.0',
      agentName: this.agentName,
      timestamp: new Date().toISOString(),
      stateHash,
      merkleRoot,
      publicKey: publicKey.toString('hex'),
    };

    const msgBytes = canonicalManifestBytes(manifest);
    const signature = Buffer.from(ed25519.sign(msgBytes, privateKey)).toString('hex');

    return {
      format: 'agentvault-arweave-bundle-v1',
      manifest,
      signature,
      state: stateJson,
    };
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  /**
   * Upload a pre-built bundle to Arweave using the supplied JWK wallet.
   * Returns the Arweave transaction ID as the bundle retrieval ID.
   */
  async uploadBundle(bundle: ArweaveBundle, jwk: JWKInterface): Promise<ArchiveResult> {
    const tags: Record<string, string> = {
      'Content-Type': 'application/json',
      'App-Name': 'AgentVault',
      'Agent-Name': bundle.manifest.agentName,
      'Bundle-Format': bundle.format,
      'State-Hash': bundle.manifest.stateHash,
      'Public-Key': bundle.manifest.publicKey,
    };

    const result = await this.arweaveClient.uploadJSON(bundle, jwk, { tags });

    if (result.success && result.transactionId) {
      return {
        success: true,
        bundleId: result.transactionId,
        transactionId: result.transactionId,
        stateHash: bundle.manifest.stateHash,
        publicKey: bundle.manifest.publicKey,
      };
    }

    return {
      success: false,
      error: result.error ?? 'Upload failed',
    };
  }

  /**
   * Convenience method: create a bundle for `state` and upload it.
   * After a successful upload the archiver clears its dirty flag.
   */
  async archive(state: Record<string, unknown>, jwk: JWKInterface): Promise<ArchiveResult> {
    try {
      const bundle = await this.createBundle(state);
      const result = await this.uploadBundle(bundle, jwk);

      if (result.success) {
        this.lastArchivedStateHash = bundle.manifest.stateHash;
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ── Retrieval ───────────────────────────────────────────────────────────────

  /**
   * Fetch a bundle from Arweave by its transaction ID.
   * Returns null if the transaction does not exist or is not a valid bundle.
   */
  async fetchBundle(bundleId: string): Promise<ArweaveBundle | null> {
    try {
      const data = await this.arweaveClient.getTransactionData(bundleId);
      if (!data) return null;

      const bundle = JSON.parse(data) as ArweaveBundle;
      if (bundle.format !== 'agentvault-arweave-bundle-v1') {
        return null;
      }

      return bundle;
    } catch {
      return null;
    }
  }

  // ── Verification ────────────────────────────────────────────────────────────

  /**
   * Verify a bundle's cryptographic integrity.
   *
   * Checks performed:
   *  1. Recompute SHA-256 of `bundle.state` → must equal `manifest.stateHash`
   *  2. Verify ed25519 signature over canonical manifest bytes using
   *     `manifest.publicKey`
   *  3. If `expectedPublicKey` is supplied, confirm it matches `manifest.publicKey`
   *
   * @param bundle - The bundle to verify (retrieved from Arweave or local store).
   * @param expectedPublicKey - Known wallet public key (64-char hex) to validate
   *   the bundle was signed by the correct wallet.
   */
  async verifyBundle(
    bundle: ArweaveBundle,
    expectedPublicKey?: string,
  ): Promise<VerifyResult> {
    try {
      const { ed25519 } = await import('@noble/curves/ed25519');

      // 1. State-hash check
      const recomputedHash = sha256Hex(bundle.state);
      const stateHashMatch = recomputedHash === bundle.manifest.stateHash;

      // 2. Signature check
      const msgBytes = canonicalManifestBytes(bundle.manifest);
      const pubKeyBytes = Buffer.from(bundle.manifest.publicKey, 'hex');
      const sigBytes = Buffer.from(bundle.signature, 'hex');
      const signatureValid = ed25519.verify(sigBytes, msgBytes, pubKeyBytes);

      // 3. Public key match
      const publicKeyMatch = expectedPublicKey
        ? expectedPublicKey === bundle.manifest.publicKey
        : true;

      return {
        valid: stateHashMatch && signatureValid && publicKeyMatch,
        stateHashMatch,
        signatureValid,
        publicKeyMatch,
      };
    } catch (error) {
      return {
        valid: false,
        stateHashMatch: false,
        signatureValid: false,
        publicKeyMatch: false,
        error: error instanceof Error ? error.message : 'Verification failed',
      };
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────────

  /**
   * Start the periodic heartbeat that auto-archives state changes.
   *
   * On every tick the heartbeat checks `isDirty`. If dirty it calls
   * `archive(currentState, jwk)` and notifies the caller via `onArchived`.
   * Errors are surfaced via `onError` rather than thrown.
   *
   * @throws {Error} if the heartbeat is already running.
   */
  startHeartbeat(options: HeartbeatOptions): void {
    if (this.heartbeatTimer !== null) {
      throw new Error('Heartbeat already running. Call stopHeartbeat() first.');
    }

    const {
      intervalMs = 60_000,
      jwk,
      onArchived,
      onError,
    } = options;

    this.heartbeatTimer = setInterval(() => {
      if (!this.isDirty || this.currentState === null) return;

      // Snapshot state at the moment of the tick to avoid races
      const snapshot = this.currentState;

      this.archive(snapshot, jwk).then((result) => {
        if (result.success) {
          onArchived?.(result);
        } else {
          onError?.(new Error(result.error ?? 'Archive failed'));
        }
      }).catch((err: unknown) => {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }, intervalMs);
  }

  /** Stop the heartbeat timer. Safe to call even if the heartbeat is not running. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Key info ────────────────────────────────────────────────────────────────

  /**
   * Return the ed25519 public key (hex) of the deployed signing wallet.
   * Returns null if the key file does not exist yet.
   */
  async getPublicKey(): Promise<string | null> {
    if (!fs.existsSync(this.signingKeyPath)) {
      return null;
    }
    const { publicKey } = await loadOrCreateSigningKey(this.signingKeyPath);
    return publicKey.toString('hex');
  }
}
