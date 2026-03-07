/**
 * Thoughtform Bundle Serializer / Deserializer
 *
 * A thoughtform-bundle is a gzipped JSON file (.json.gz) that wraps agent
 * backup data in a self-describing envelope with integrity checksums.
 *
 * Format:
 *   gzip( JSON({
 *     format: 'agentvault-thoughtform-bundle-v1',
 *     createdAt: ISO-8601,
 *     manifest: BackupManifest,
 *     entries: Record<string, string>   // path → base64 content
 *   }) )
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { BackupManifest, BackupOptions, BackupResult, CanisterState } from './backup.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const THOUGHTFORM_BUNDLE_FORMAT = 'agentvault-thoughtform-bundle-v1';

export interface ThoughtformBundle {
  format: typeof THOUGHTFORM_BUNDLE_FORMAT;
  createdAt: string;
  manifest: BackupManifest;
  entries: Record<string, string>;
}

/**
 * Serialize agent backup data to a gzipped thoughtform-bundle.
 *
 * Writes a `.json.gz` file at `outputPath`.
 */
export async function serializeThoughtformBundle(
  options: BackupOptions
): Promise<BackupResult> {
  try {
    const {
      agentName,
      outputPath,
      includeConfig = true,
      canisterId,
      includeCanisterState = false,
    } = options;

    const entries: Record<string, string> = {};
    const components: string[] = [];

    // Config entry
    if (includeConfig) {
      const configPayload = JSON.stringify(
        { agentName, canisterId: canisterId ?? agentName },
        null,
        2
      );
      entries['config.json'] = Buffer.from(configPayload, 'utf8').toString('base64');
      components.push('config');
    }

    // Optional canister state
    let canisterState: CanisterState | undefined;
    if (includeCanisterState && canisterId) {
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
        canisterState = {
          canisterId,
          status: statusMap[status.status] || 'stopped',
          memorySize: status.memorySize,
          cycles: status.cycles,
          fetchedAt: new Date().toISOString(),
        };
        entries['canister-state.json'] = Buffer.from(
          JSON.stringify(canisterState, null, 2),
          'utf8'
        ).toString('base64');
        components.push('canister-state');
      } catch {
        // Canister state unavailable — continue without it
      }
    }

    // Checksums for each entry
    const checksums: Record<string, string> = {};
    for (const [entryPath, b64] of Object.entries(entries)) {
      checksums[entryPath] = crypto
        .createHash('sha256')
        .update(Buffer.from(b64, 'base64'))
        .digest('hex');
    }

    const now = new Date();
    const manifest: BackupManifest = {
      version: '1.0',
      agentName,
      timestamp: now,
      created: now,
      canisterId: canisterId ?? agentName,
      canisterState,
      checksums,
      size: 0,
      components,
    };

    const bundle: ThoughtformBundle = {
      format: THOUGHTFORM_BUNDLE_FORMAT,
      createdAt: now.toISOString(),
      manifest,
      entries,
    };

    const jsonBuf = Buffer.from(JSON.stringify(bundle), 'utf8');
    const compressed = await gzip(jsonBuf);

    // Determine output path
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const defaultOut = `${agentName}-${timestamp}.thoughtform-bundle.json.gz`;
    const filePath = outputPath || path.resolve(process.cwd(), defaultOut);

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, compressed);

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

/**
 * Deserialize a gzipped thoughtform-bundle back to its manifest and entries.
 *
 * Returns the parsed bundle or throws on invalid data.
 */
export async function deserializeThoughtformBundle(
  filePath: string
): Promise<ThoughtformBundle> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const compressed = fs.readFileSync(filePath);
  const decompressed = await gunzip(compressed);
  const bundle = JSON.parse(decompressed.toString('utf8')) as ThoughtformBundle;

  if (bundle.format !== THOUGHTFORM_BUNDLE_FORMAT) {
    throw new Error(
      `Invalid thoughtform-bundle format: expected '${THOUGHTFORM_BUNDLE_FORMAT}', got '${bundle.format}'`
    );
  }

  // Verify checksums
  for (const [entryPath, expectedHash] of Object.entries(bundle.manifest.checksums)) {
    const content = bundle.entries[entryPath];
    if (content === undefined) {
      throw new Error(`Missing entry referenced in checksums: ${entryPath}`);
    }
    const actualHash = crypto
      .createHash('sha256')
      .update(Buffer.from(content, 'base64'))
      .digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error(`Checksum mismatch for ${entryPath}: expected ${expectedHash}, got ${actualHash}`);
    }
  }

  return bundle;
}
