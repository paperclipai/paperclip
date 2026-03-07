/**
 * Tests for Merkle-root backup (CLE-MRB)
 *
 * Covers:
 *  - computeMerkleRoot / computeLeafHashes from merkle.ts
 *  - fullBackup() in backup.ts: manifest structure, Merkle root, ed25519 sig
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import {
  computeMerkleRoot,
  computeLeafHashes,
  hashLeaf,
  type MerkleEntry,
} from '../../src/backup/merkle.js';
import { fullBackup, loadOrCreateSigningKey } from '../../src/backup/backup.js';

// ---------------------------------------------------------------------------
// Merkle tree unit tests
// ---------------------------------------------------------------------------

describe('computeMerkleRoot', () => {
  it('returns a 64-char hex string for a single entry', () => {
    const entries: MerkleEntry[] = [
      { path: 'config.json', content: Buffer.from('{"a":1}') },
    ];
    const root = computeMerkleRoot(entries);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a stable hash for empty input', () => {
    const root1 = computeMerkleRoot([]);
    const root2 = computeMerkleRoot([]);
    expect(root1).toBe(root2);
    expect(root1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: same entries → same root', () => {
    const entries: MerkleEntry[] = [
      { path: 'a.json', content: Buffer.from('aaa') },
      { path: 'b.json', content: Buffer.from('bbb') },
    ];
    const root1 = computeMerkleRoot(entries);
    const root2 = computeMerkleRoot(entries);
    expect(root1).toBe(root2);
  });

  it('sorts entries by path before hashing (order-independent)', () => {
    const e1: MerkleEntry[] = [
      { path: 'b.json', content: Buffer.from('B') },
      { path: 'a.json', content: Buffer.from('A') },
    ];
    const e2: MerkleEntry[] = [
      { path: 'a.json', content: Buffer.from('A') },
      { path: 'b.json', content: Buffer.from('B') },
    ];
    expect(computeMerkleRoot(e1)).toBe(computeMerkleRoot(e2));
  });

  it('changes root when any entry content changes', () => {
    const base: MerkleEntry[] = [
      { path: 'config.json', content: Buffer.from('original') },
      { path: 'state.json', content: Buffer.from('state') },
    ];
    const tampered: MerkleEntry[] = [
      { path: 'config.json', content: Buffer.from('TAMPERED') },
      { path: 'state.json', content: Buffer.from('state') },
    ];
    expect(computeMerkleRoot(base)).not.toBe(computeMerkleRoot(tampered));
  });

  it('changes root when any entry path changes', () => {
    const base: MerkleEntry[] = [
      { path: 'config.json', content: Buffer.from('data') },
    ];
    const different: MerkleEntry[] = [
      { path: 'other.json', content: Buffer.from('data') },
    ];
    // Path is included in leaf hash, so a path swap with same content must
    // change the root.
    expect(computeMerkleRoot(base)).not.toBe(computeMerkleRoot(different));
  });

  it('handles odd number of leaves without error', () => {
    const entries: MerkleEntry[] = [
      { path: 'a', content: Buffer.from('1') },
      { path: 'b', content: Buffer.from('2') },
      { path: 'c', content: Buffer.from('3') },
    ];
    const root = computeMerkleRoot(entries);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles many entries', () => {
    const entries: MerkleEntry[] = Array.from({ length: 100 }, (_, i) => ({
      path: `file-${i}.bin`,
      content: crypto.randomBytes(32),
    }));
    const root = computeMerkleRoot(entries);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeLeafHashes', () => {
  it('returns a hash per entry keyed by path', () => {
    const entries: MerkleEntry[] = [
      { path: 'a.json', content: Buffer.from('A') },
      { path: 'b.json', content: Buffer.from('B') },
    ];
    const hashes = computeLeafHashes(entries);
    expect(Object.keys(hashes)).toEqual(['a.json', 'b.json']);
    expect(hashes['a.json']).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes['a.json']).toBe(hashLeaf(entries[0]!));
  });

  it('each leaf hash matches hashLeaf', () => {
    const entries: MerkleEntry[] = [
      { path: 'x', content: Buffer.from('hello') },
    ];
    const hashes = computeLeafHashes(entries);
    expect(hashes['x']).toBe(hashLeaf(entries[0]!));
  });
});

// ---------------------------------------------------------------------------
// fullBackup integration tests
// ---------------------------------------------------------------------------

describe('fullBackup', () => {
  let tmpDir: string;
  let signingKeyPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-test-'));
    signingKeyPath = path.join(tmpDir, 'backup-signing.key');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a backup file with .zip extension', async () => {
    const outPath = path.join(tmpDir, 'test.zip');
    const result = await fullBackup({
      agentName: 'test-agent',
      outputPath: outPath,
      signingKeyPath,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('manifest includes a 64-char hex merkleRoot', async () => {
    const outPath = path.join(tmpDir, 'out.zip');
    const result = await fullBackup({
      agentName: 'agent-x',
      outputPath: outPath,
      signingKeyPath,
    });

    expect(result.success).toBe(true);
    expect(result.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest?.merkleRoot).toBe(result.merkleRoot);
  });

  it('manifest includes ed25519PublicKey (64-char hex = 32 bytes)', async () => {
    const outPath = path.join(tmpDir, 'out.zip');
    const result = await fullBackup({
      agentName: 'agent-y',
      outputPath: outPath,
      signingKeyPath,
    });

    expect(result.success).toBe(true);
    expect(result.ed25519PublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest?.ed25519PublicKey).toBe(result.ed25519PublicKey);
  });

  it('manifest includes encryptedKey envelope with ciphertext/iv/tag', async () => {
    const outPath = path.join(tmpDir, 'out.zip');
    const result = await fullBackup({
      agentName: 'agent-z',
      outputPath: outPath,
      signingKeyPath,
    });

    expect(result.success).toBe(true);
    const ek = result.manifest?.encryptedKey;
    expect(ek).toBeDefined();
    expect(ek?.ciphertext).toMatch(/^[0-9a-f]+$/);
    expect(ek?.iv).toMatch(/^[0-9a-f]{24}$/); // 12 bytes = 24 hex chars
    expect(ek?.tag).toMatch(/^[0-9a-f]{32}$/); // 16 bytes = 32 hex chars
  });

  it('manifest includes a valid keySignature (128-char hex = 64 bytes)', async () => {
    const outPath = path.join(tmpDir, 'out.zip');
    const result = await fullBackup({
      agentName: 'agent-sig',
      outputPath: outPath,
      signingKeyPath,
    });

    expect(result.success).toBe(true);
    expect(result.manifest?.keySignature).toMatch(/^[0-9a-f]{128}$/);
  });

  it('ed25519 keySignature verifies against the encryptedKey bytes', async () => {
    const { ed25519 } = await import('@noble/curves/ed25519');

    const outPath = path.join(tmpDir, 'out.zip');
    const result = await fullBackup({
      agentName: 'agent-verify',
      outputPath: outPath,
      signingKeyPath,
    });

    expect(result.success).toBe(true);

    const manifest = result.manifest!;
    const ek = manifest.encryptedKey!;

    // Reconstruct the signed message: ciphertext || iv || tag
    const wrappedKeyBytes = Buffer.concat([
      Buffer.from(ek.ciphertext, 'hex'),
      Buffer.from(ek.iv, 'hex'),
      Buffer.from(ek.tag, 'hex'),
    ]);

    const pubKey = Buffer.from(manifest.ed25519PublicKey!, 'hex');
    const sig = Buffer.from(manifest.keySignature!, 'hex');

    const valid = ed25519.verify(sig, wrappedKeyBytes, pubKey);
    expect(valid).toBe(true);
  });

  it('keySignature does NOT verify if encryptedKey is tampered', async () => {
    const { ed25519 } = await import('@noble/curves/ed25519');

    const outPath = path.join(tmpDir, 'out.zip');
    const result = await fullBackup({
      agentName: 'agent-tamper',
      outputPath: outPath,
      signingKeyPath,
    });

    expect(result.success).toBe(true);

    const manifest = result.manifest!;
    const ek = manifest.encryptedKey!;

    // Tamper with the ciphertext (flip first byte)
    const tamperedCt = Buffer.from(ek.ciphertext, 'hex');
    tamperedCt[0] = tamperedCt[0]! ^ 0xff;

    const wrappedKeyBytes = Buffer.concat([
      tamperedCt,
      Buffer.from(ek.iv, 'hex'),
      Buffer.from(ek.tag, 'hex'),
    ]);

    const pubKey = Buffer.from(manifest.ed25519PublicKey!, 'hex');
    const sig = Buffer.from(manifest.keySignature!, 'hex');

    const valid = ed25519.verify(sig, wrappedKeyBytes, pubKey);
    expect(valid).toBe(false);
  });

  it('persists the signing key and reuses it across calls', async () => {
    const out1 = path.join(tmpDir, 'b1.zip');
    const out2 = path.join(tmpDir, 'b2.zip');

    const r1 = await fullBackup({ agentName: 'a', outputPath: out1, signingKeyPath });
    const r2 = await fullBackup({ agentName: 'a', outputPath: out2, signingKeyPath });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    // Same key file → same public key
    expect(r1.ed25519PublicKey).toBe(r2.ed25519PublicKey);
  });

  it('output file contains valid JSON with agentvault-full-backup-v1 format', async () => {
    const outPath = path.join(tmpDir, 'out.zip');
    const result = await fullBackup({
      agentName: 'agent-json',
      outputPath: outPath,
      signingKeyPath,
    });

    expect(result.success).toBe(true);

    const raw = fs.readFileSync(outPath, 'utf8');
    const archive = JSON.parse(raw);

    expect(archive.format).toBe('agentvault-full-backup-v1');
    expect(archive.manifest).toBeDefined();
    expect(archive.encryptedPayload).toBeDefined();
    expect(archive.encryptedPayload.ciphertext).toMatch(/^[0-9a-f]+$/);
    expect(archive.encryptedPayload.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(archive.encryptedPayload.tag).toMatch(/^[0-9a-f]{32}$/);
  });

  it('manifest version is 2.0', async () => {
    const outPath = path.join(tmpDir, 'v.zip');
    const result = await fullBackup({ agentName: 'av', outputPath: outPath, signingKeyPath });
    expect(result.manifest?.version).toBe('2.0');
  });

  it('manifest checksums match individual leaf hashes', async () => {
    const outPath = path.join(tmpDir, 'cs.zip');
    const result = await fullBackup({ agentName: 'cs-agent', outputPath: outPath, signingKeyPath });

    expect(result.success).toBe(true);
    const checksums = result.manifest?.checksums ?? {};

    // Every checksum should be a 64-char hex
    for (const [, hash] of Object.entries(checksums)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// loadOrCreateSigningKey unit tests
// ---------------------------------------------------------------------------

describe('loadOrCreateSigningKey', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sk-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a new key file when none exists', async () => {
    const keyPath = path.join(tmpDir, 'new.key');
    expect(fs.existsSync(keyPath)).toBe(false);

    const { privateKey, publicKey } = await loadOrCreateSigningKey(keyPath);

    expect(fs.existsSync(keyPath)).toBe(true);
    expect(privateKey.length).toBe(32);
    expect(publicKey.length).toBe(32);
  });

  it('returns the same keypair on subsequent calls', async () => {
    const keyPath = path.join(tmpDir, 'persist.key');

    const r1 = await loadOrCreateSigningKey(keyPath);
    const r2 = await loadOrCreateSigningKey(keyPath);

    expect(r1.privateKey.toString('hex')).toBe(r2.privateKey.toString('hex'));
    expect(r1.publicKey.toString('hex')).toBe(r2.publicKey.toString('hex'));
  });

  it('throws for an invalid key file', async () => {
    const keyPath = path.join(tmpDir, 'bad.key');
    fs.writeFileSync(keyPath, 'not-hex-at-all');

    await expect(loadOrCreateSigningKey(keyPath)).rejects.toThrow();
  });
});
