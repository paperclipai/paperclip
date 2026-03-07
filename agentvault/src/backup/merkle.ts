/**
 * Merkle Tree Utilities for Backup Integrity
 *
 * Computes a SHA-256 Merkle root over all backup file entries so that
 * any swap or corruption of a single file invalidates the root and can
 * be detected before restore.
 *
 * Tree construction:
 *  1. Entries are sorted by path for deterministic ordering.
 *  2. Each leaf is SHA-256(utf8(path) || content).
 *  3. Parent nodes are SHA-256(hex(left) || hex(right)).
 *  4. If the number of leaves at a level is odd, the last node is promoted
 *     unchanged (not duplicated) so that a single-entry tree is just its
 *     own leaf hash.
 */

import crypto from 'node:crypto';

export interface MerkleEntry {
  /** Logical path within the backup archive, e.g. "config.json" */
  path: string;
  /** Raw file content */
  content: Buffer;
}

/**
 * Compute SHA-256 of a buffer and return a lowercase hex string.
 */
function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Hash a single leaf: SHA-256(path_bytes || content).
 * Including the path in the leaf prevents path-swapping attacks.
 */
export function hashLeaf(entry: MerkleEntry): string {
  const pathBuf = Buffer.from(entry.path, 'utf8');
  return sha256(Buffer.concat([pathBuf, entry.content]));
}

/**
 * Hash two sibling nodes: SHA-256(hex(left) || hex(right)).
 */
function hashPair(left: string, right: string): string {
  return sha256(Buffer.from(left + right, 'utf8'));
}

/**
 * Compute the Merkle root (SHA-256) of all backup entries.
 *
 * @param entries - Array of { path, content } objects.
 *                  Must be non-empty.
 * @returns 64-character lowercase hex Merkle root.
 */
export function computeMerkleRoot(entries: MerkleEntry[]): string {
  if (entries.length === 0) {
    // Empty tree: hash of empty string
    return sha256(Buffer.alloc(0));
  }

  // Sort by path for deterministic ordering
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  // Build leaf-level hashes
  let level: string[] = sorted.map(hashLeaf);

  // Reduce levels until we reach the root
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      if (i + 1 < level.length) {
        next.push(hashPair(left, level[i + 1]!));
      } else {
        // Odd node: promote without pairing
        next.push(left);
      }
    }
    level = next;
  }

  return level[0]!;
}

/**
 * Compute individual leaf hashes for every entry.
 * These are stored in manifest.checksums so a verifier can check
 * individual files without reconstructing the whole tree.
 *
 * @param entries - Same set used to compute the Merkle root.
 * @returns A record mapping path → leaf hash hex.
 */
export function computeLeafHashes(entries: MerkleEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    result[entry.path] = hashLeaf(entry);
  }
  return result;
}
