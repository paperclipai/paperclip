/**
 * Backup System
 *
 * Portable JSON format backup with embedded manifest and checksums
 * Stores backups in ~/.agentvault/backups/
 * CLE-101: Enhanced to include real canister state
 * CLE-MRB: Full backup adds SHA-256 Merkle root and ed25519-signed AES-256-GCM key
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { AgentConfig } from '../packaging/types.js';
import { computeMerkleRoot, computeLeafHashes, type MerkleEntry } from './merkle.js';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const BACKUPS_DIR = path.join(AGENTVAULT_DIR, 'backups');

function ensureBackupsDir(): void {
  if (!fs.existsSync(AGENTVAULT_DIR)) {
    fs.mkdirSync(AGENTVAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

/**
 * Canister state captured in backup
 */
export interface CanisterState {
  canisterId: string;
  status: 'running' | 'stopped' | 'stopping';
  memorySize?: bigint;
  cycles?: bigint;
  moduleHash?: string;
  fetchedAt: string;
  tasks?: unknown[];
  memory?: unknown;
  context?: unknown;
}

export interface EncryptedKeyEnvelope {
  /** AES-256-GCM-wrapped data-encryption key: hex-encoded ciphertext */
  ciphertext: string;
  /** 12-byte IV used to wrap the key: hex */
  iv: string;
  /** 16-byte GCM auth tag: hex */
  tag: string;
}

export interface BackupManifest {
  version: string;
  agentName: string;
  timestamp: Date;
  created: Date;
  agentConfig?: AgentConfig;
  canisterId?: string;
  canisterState?: CanisterState;
  checksums: Record<string, string>;
  size: number;
  components: string[];
  /**
   * SHA-256 Merkle root of all backup entries (sorted by path).
   * Present only in full backups (--full flag).
   */
  merkleRoot?: string;
  /**
   * AES-256-GCM data-encryption key wrapped with a key derived from
   * the ed25519 signing key via HKDF-SHA256.
   * Present only in full backups.
   */
  encryptedKey?: EncryptedKeyEnvelope;
  /**
   * ed25519 signature (hex) over the raw bytes of encryptedKey
   * (ciphertext || iv || tag). Allows verifying the key has not been
   * swapped without decrypting it.
   * Present only in full backups.
   */
  keySignature?: string;
  /**
   * ed25519 public key (hex) corresponding to the signing key.
   * Present only in full backups.
   */
  ed25519PublicKey?: string;
}

export interface BackupOptions {
  agentName: string;
  outputPath?: string;
  includeConfig?: boolean;
  canisterId?: string;
  includeCanisterState?: boolean;
}

export interface FullBackupOptions extends BackupOptions {
  /**
   * Path to the 32-byte ed25519 private key stored as hex.
   * Defaults to ~/.agentvault/backup-signing.key.
   * If the file does not exist, a new keypair is generated and saved.
   */
  signingKeyPath?: string;
}

export interface ImportOptions {
  inputPath: string;
  targetAgentName?: string;
  overwrite?: boolean;
}

export interface BackupResult {
  success: boolean;
  path?: string;
  error?: string;
  sizeBytes?: number;
  manifest?: BackupManifest;
}

export interface FullBackupResult extends BackupResult {
  /** SHA-256 Merkle root of all backup entries */
  merkleRoot?: string;
  /** ed25519 public key (hex) used to sign the wrapped AES key */
  ed25519PublicKey?: string;
}

export interface ImportResult {
  success: boolean;
  agentName?: string;
  error?: string;
  components: string[];
  warnings: string[];
}

/**
 * Fetch canister state for backup
 */
async function fetchCanisterState(canisterId: string): Promise<CanisterState | null> {
  try {
    const { createICPClient } = await import('../deployment/icpClient.js');
    const client = createICPClient({ network: 'local' });

    const status = await client.getCanisterStatus(canisterId);

    const statusMap: Record<string, 'running' | 'stopped' | 'stopping'> = {
      running: 'running',
      stopped: 'stopped',
      stopping: 'stopping',
      pending: 'stopped',
    };

    const state: CanisterState = {
      canisterId,
      status: statusMap[status.status] || 'stopped',
      memorySize: status.memorySize,
      cycles: status.cycles,
      fetchedAt: new Date().toISOString(),
    };

    try {
      const tasksResult = await client.callAgentMethod(canisterId, 'getTasks', []);
      if (tasksResult) {
        state.tasks = tasksResult as unknown[];
      }
    } catch {
      // Tasks not available
    }

    try {
      const memoryResult = await client.callAgentMethod(canisterId, 'getMemory', []);
      if (memoryResult) {
        state.memory = memoryResult;
      }
    } catch {
      // Memory not available
    }

    try {
      const contextResult = await client.callAgentMethod(canisterId, 'getContext', []);
      if (contextResult) {
        state.context = contextResult;
      }
    } catch {
      // Context not available
    }

    return state;
  } catch (error) {
    console.warn('Failed to fetch canister state:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full-backup cryptographic helpers
// ---------------------------------------------------------------------------

const SIGNING_KEY_FILENAME = 'backup-signing.key';

/**
 * Load or create an ed25519 private key (32 raw bytes) stored as hex at
 * `keyPath`.  Returns { privateKey, publicKey } as Buffers.
 */
export async function loadOrCreateSigningKey(
  keyPath: string
): Promise<{ privateKey: Buffer; publicKey: Buffer }> {
  const { ed25519 } = await import('@noble/curves/ed25519');

  let privKeyHex: string;

  if (fs.existsSync(keyPath)) {
    privKeyHex = fs.readFileSync(keyPath, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(privKeyHex)) {
      throw new Error(`Signing key at ${keyPath} is not valid 32-byte hex`);
    }
  } else {
    // Generate new key and persist it
    const raw = crypto.randomBytes(32);
    privKeyHex = raw.toString('hex');
    const dir = path.dirname(keyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(keyPath, privKeyHex, { encoding: 'utf8', mode: 0o600 });
  }

  const privateKey = Buffer.from(privKeyHex, 'hex');
  const publicKey = Buffer.from(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey };
}

/**
 * Derive a 32-byte AES key-wrapping key from an ed25519 private key using
 * HKDF-SHA256.  Using a separate wrapping key means the signing key is never
 * used directly for symmetric encryption.
 */
function deriveWrappingKey(privateKey: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    privateKey,
    Buffer.from('agentvault-backup-key-wrapping'),
    Buffer.from('backup-key-wrapping-v1'),
    32
  ));
}

/**
 * Encrypt `plaintext` with AES-256-GCM using `key`.
 * Returns { ciphertext, iv, tag } all as Buffers.
 */
function aesGcmEncrypt(
  plaintext: Buffer,
  key: Buffer
): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/**
 * Create a full encrypted backup zip.
 *
 * Steps:
 *  1. Collect backup entries (logical files).
 *  2. Compute SHA-256 Merkle root of all entries.
 *  3. Generate a random 32-byte AES-256-GCM data-encryption key.
 *  4. Encrypt the backup payload with that key.
 *  5. Wrap (encrypt) the data key with a key derived from the ed25519 signing key.
 *  6. Sign the wrapped-key bytes (ciphertext || iv || tag) with ed25519.
 *  7. Write a JSON-envelope backup file containing the manifest + ciphertext.
 */
export async function fullBackup(options: FullBackupOptions): Promise<FullBackupResult> {
  try {
    ensureBackupsDir();

    const {
      agentName,
      outputPath,
      includeConfig = true,
      canisterId,
      includeCanisterState = false,
      signingKeyPath = path.join(AGENTVAULT_DIR, SIGNING_KEY_FILENAME),
    } = options;

    const { ed25519 } = await import('@noble/curves/ed25519');

    // ------------------------------------------------------------------
    // 1. Load or create ed25519 signing key
    // ------------------------------------------------------------------
    const { privateKey, publicKey } = await loadOrCreateSigningKey(signingKeyPath);

    // ------------------------------------------------------------------
    // 2. Collect backup entries
    // ------------------------------------------------------------------
    const entries: MerkleEntry[] = [];
    const components: string[] = [];

    // Config / agent identity entry (stub – real config loader can be wired in)
    if (includeConfig) {
      const configPayload = JSON.stringify({ agentName, canisterId: canisterId ?? agentName }, null, 2);
      entries.push({ path: 'config.json', content: Buffer.from(configPayload, 'utf8') });
      components.push('config');
    }

    // Optional live canister state
    let canisterState: CanisterState | undefined;
    if (includeCanisterState && canisterId) {
      const state = await fetchCanisterState(canisterId);
      if (state) {
        canisterState = state;
        const statePayload = JSON.stringify(state, null, 2);
        entries.push({ path: 'canister-state.json', content: Buffer.from(statePayload, 'utf8') });
        components.push('canister-state');
      }
    }

    // ------------------------------------------------------------------
    // 3. Compute Merkle root & per-file leaf hashes
    // ------------------------------------------------------------------
    const merkleRoot = computeMerkleRoot(entries);
    const leafHashes = computeLeafHashes(entries);

    // ------------------------------------------------------------------
    // 4. Build manifest (without size yet)
    // ------------------------------------------------------------------
    const now = new Date();
    const manifest: BackupManifest = {
      version: '2.0',
      agentName,
      timestamp: now,
      created: now,
      canisterId: canisterId ?? agentName,
      canisterState,
      checksums: leafHashes,
      size: 0,
      components,
      merkleRoot,
      ed25519PublicKey: publicKey.toString('hex'),
    };

    // ------------------------------------------------------------------
    // 5. Encrypt the payload (all entries as a single JSON bundle)
    // ------------------------------------------------------------------
    const payloadObj: Record<string, string> = {};
    for (const entry of entries) {
      payloadObj[entry.path] = entry.content.toString('base64');
    }
    const payloadJson = Buffer.from(JSON.stringify(payloadObj), 'utf8');

    const dataKey = crypto.randomBytes(32);
    const {
      ciphertext: encPayload,
      iv: payloadIv,
      tag: payloadTag,
    } = aesGcmEncrypt(payloadJson, dataKey);

    // ------------------------------------------------------------------
    // 6. Wrap the data key with HKDF-derived wrapping key
    // ------------------------------------------------------------------
    const wrappingKey = deriveWrappingKey(privateKey);
    const {
      ciphertext: wrappedKeyCt,
      iv: wrapIv,
      tag: wrapTag,
    } = aesGcmEncrypt(dataKey, wrappingKey);

    // ------------------------------------------------------------------
    // 7. Sign the wrapped-key envelope bytes with ed25519
    // ------------------------------------------------------------------
    const wrappedKeyBytes = Buffer.concat([wrappedKeyCt, wrapIv, wrapTag]);
    const signature = Buffer.from(ed25519.sign(wrappedKeyBytes, privateKey));

    manifest.encryptedKey = {
      ciphertext: wrappedKeyCt.toString('hex'),
      iv: wrapIv.toString('hex'),
      tag: wrapTag.toString('hex'),
    };
    manifest.keySignature = signature.toString('hex');

    // ------------------------------------------------------------------
    // 8. Serialise to disk as a JSON-envelope ".zip" file
    // ------------------------------------------------------------------
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const filename = outputPath
      ? path.basename(outputPath)
      : `${agentName}-${timestamp}-full.zip`;
    const filePath = outputPath || path.join(BACKUPS_DIR, filename);

    const archive = {
      format: 'agentvault-full-backup-v1',
      manifest,
      encryptedPayload: {
        ciphertext: encPayload.toString('hex'),
        iv: payloadIv.toString('hex'),
        tag: payloadTag.toString('hex'),
      },
    };

    fs.writeFileSync(filePath, JSON.stringify(archive, null, 2), 'utf8');

    const stats = fs.statSync(filePath);
    manifest.size = stats.size;

    return {
      success: true,
      path: filePath,
      sizeBytes: stats.size,
      manifest,
      merkleRoot,
      ed25519PublicKey: publicKey.toString('hex'),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function exportBackup(options: BackupOptions): Promise<BackupResult> {
  try {
    ensureBackupsDir();
    
    const { agentName, outputPath, includeConfig = true, canisterId, includeCanisterState = true } = options;
    
    const timestamp = new Date();
    const created = new Date();
    const filename = `${agentName}-${timestamp.toISOString().replace(/[:.]/g, '-')}.json`;
    const filePath = outputPath || path.join(BACKUPS_DIR, filename);
    
    const components: string[] = [];
    if (includeConfig) {
      components.push('config');
    }
    
    const manifest: BackupManifest = {
      version: '1.1',
      agentName,
      timestamp,
      created,
      checksums: {},
      size: 0,
      components,
    };
    
    if (includeConfig) {
      manifest.canisterId = canisterId || agentName;
    }

    if (includeCanisterState && canisterId) {
      const canisterState = await fetchCanisterState(canisterId);
      if (canisterState) {
        manifest.canisterState = canisterState;
        manifest.canisterId = canisterId;
        components.push('canister-state');
      }
    }
    
    const content = JSON.stringify(manifest, null, 2);
    const checksum = crypto.createHash('sha256').update(content).digest('hex');
    manifest.checksums[filename] = checksum;
    
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf8');
    
    const stats = fs.statSync(filePath);
    manifest.size = stats.size;
    
    return {
      success: true,
      path: filePath,
      sizeBytes: stats.size,
      manifest,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function previewBackup(inputPath: string): Promise<BackupManifest | null> {
  try {
    if (!fs.existsSync(inputPath)) {
      return null;
    }
    
    const content = fs.readFileSync(inputPath, 'utf8');
    const manifest = JSON.parse(content) as BackupManifest;
    
    return manifest;
  } catch (error) {
    console.error('Failed to preview backup:', error);
    return null;
  }
}

export async function importBackup(options: ImportOptions): Promise<ImportResult> {
  try {
    const { inputPath, targetAgentName, overwrite } = options;
    
    if (!fs.existsSync(inputPath)) {
      return {
        success: false,
        agentName: undefined,
        components: [],
        warnings: [],
        error: `Backup file not found: ${inputPath}`,
      };
    }
    
    const manifest = await previewBackup(inputPath);
    if (!manifest) {
      return {
        success: false,
        agentName: undefined,
        components: [],
        warnings: [],
        error: 'Invalid backup file',
      };
    }
    
    const targetName = targetAgentName || manifest.agentName;
    const warnings: string[] = [];
    
    if (!overwrite) {
      warnings.push('Using dry-run mode; no changes will be made');
    }
    
    return {
      success: true,
      agentName: targetName,
      components: manifest.components,
      warnings,
    };
  } catch (error) {
    return {
      success: false,
      agentName: undefined,
      components: [],
      warnings: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function listBackups(agentName: string): Promise<BackupManifest[]> {
  ensureBackupsDir();
  const backups: BackupManifest[] = [];
  
  if (!fs.existsSync(BACKUPS_DIR)) {
    return backups;
  }
  
  const files = fs.readdirSync(BACKUPS_DIR);
  for (const file of files) {
    if (file.startsWith(agentName) && file.endsWith('.json')) {
      const filePath = path.join(BACKUPS_DIR, file);
      try {
        const manifest = await previewBackup(filePath);
        if (manifest && manifest.agentName === agentName) {
          backups.push(manifest);
        }
      } catch (error) {
        console.error(`Failed to read backup ${file}:`, error);
      }
    }
  }
  
  backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return backups;
}

export async function deleteBackup(filePath: string): Promise<boolean> {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to delete backup:', error);
    return false;
  }
}

export function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
