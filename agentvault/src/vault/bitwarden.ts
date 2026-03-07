/**
 * Bitwarden CLI secret provider for AgentVault
 *
 * Uses the official Bitwarden CLI (`bw`) as a secret backend alternative to
 * HashiCorp Vault.  Secrets are stored as Bitwarden "Secure Note" items with
 * a naming convention of `agentvault/<agentId>/<key>`.
 *
 * Prerequisites:
 *   1. Install the Bitwarden CLI: https://bitwarden.com/help/cli/
 *      brew install bitwarden-cli   (macOS)
 *      npm install -g @bitwarden/cli
 *   2. Log in and unlock:
 *      bw login
 *      export BW_SESSION="$(bw unlock --raw)"
 *
 * The provider reads BW_SESSION from the environment at construction time.
 * It never stores the session key or any secret value on disk.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SecretProvider, SecretProviderHealth } from './provider.js';

const execFileAsync = promisify(execFile);

/** Shape of a Bitwarden secure-note item returned by `bw get item` */
interface BWItem {
  id: string;
  name: string;
  type: number; // 2 = Secure Note
  notes: string | null;
  object: string;
}

/** Shape of `bw status` output */
interface BWStatus {
  serverUrl: string | null;
  lastSync: string;
  userEmail: string;
  userId: string;
  status: 'unauthenticated' | 'locked' | 'unlocked';
}

export interface BitwardenConfig {
  /** BW_SESSION unlock token.  Defaults to `process.env.BW_SESSION`. */
  session?: string;
  /** Agent identifier used to namespace secret names. */
  agentId: string;
  /**
   * Path to the `bw` binary.  Defaults to `bw` (resolved via PATH).
   */
  bwBin?: string;
}

export class BitwardenProvider implements SecretProvider {
  readonly name = 'Bitwarden CLI';

  private readonly agentId: string;
  private readonly bwBin: string;
  private readonly session: string;

  constructor(config: BitwardenConfig) {
    this.agentId = config.agentId;
    this.bwBin = config.bwBin ?? 'bw';

    const session = config.session ?? process.env.BW_SESSION;
    if (!session) {
      throw new Error(
        'Bitwarden session key is required. ' +
        'Run `bw unlock --raw` and set BW_SESSION, ' +
        'or pass the session via BitwardenConfig.session.',
      );
    }
    this.session = session;
  }

  /** Namespaced item name for a given secret key. */
  private itemName(key: string): string {
    return `agentvault/${this.agentId}/${key}`;
  }

  /**
   * Run a `bw` sub-command with the session token injected.
   * stderr is surfaced only when the command fails.
   */
  private async bw(args: string[]): Promise<string> {
    const env = {
      ...process.env,
      BW_SESSION: this.session,
    };

    const { stdout, stderr } = await execFileAsync(this.bwBin, args, {
      env,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    }).catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
      // execFile rejects on non-zero exit; surface stderr for diagnostics
      const detail = err.stderr?.trim() || err.message;
      throw new Error(`bw ${args[0]} failed: ${detail}`);
    });

    if (stderr?.trim()) {
      // Non-fatal stderr (e.g. sync messages) – ignore
    }

    return stdout.trim();
  }

  /** Parse JSON output from `bw`, returning null on empty or non-JSON output. */
  private tryParseJSON<T>(raw: string): T | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async getSecret(key: string): Promise<string | null> {
    const name = this.itemName(key);
    try {
      const raw = await this.bw(['get', 'item', name, '--nointeraction']);
      const item = this.tryParseJSON<BWItem>(raw);
      return item?.notes ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Bitwarden returns non-zero when the item doesn't exist
      if (msg.includes('Not found') || msg.includes('No results')) return null;
      throw err;
    }
  }

  async storeSecret(key: string, value: string): Promise<void> {
    const name = this.itemName(key);

    // Check if the item already exists so we can update vs create
    let existingId: string | null = null;
    try {
      const raw = await this.bw(['get', 'item', name, '--nointeraction']);
      const item = this.tryParseJSON<BWItem>(raw);
      existingId = item?.id ?? null;
    } catch {
      existingId = null;
    }

    // Build Bitwarden item JSON (type 2 = Secure Note)
    const payload = JSON.stringify({
      type: 2,
      name,
      notes: value,
      secureNote: { type: 0 },
    });

    // Encode to base64 as required by `bw create`
    const encoded = Buffer.from(payload).toString('base64');

    if (existingId) {
      await this.bw(['edit', 'item', existingId, encoded, '--nointeraction']);
    } else {
      await this.bw(['create', 'item', encoded, '--nointeraction']);
    }
  }

  async listSecrets(): Promise<string[]> {
    const prefix = `agentvault/${this.agentId}/`;
    try {
      const raw = await this.bw(['list', 'items', '--search', `agentvault/${this.agentId}`, '--nointeraction']);
      const items = this.tryParseJSON<BWItem[]>(raw);
      if (!items) return [];
      return items
        .filter((i) => i.name.startsWith(prefix))
        .map((i) => i.name.slice(prefix.length));
    } catch {
      return [];
    }
  }

  async deleteSecret(key: string): Promise<void> {
    const name = this.itemName(key);
    const raw = await this.bw(['get', 'item', name, '--nointeraction']);
    const item = this.tryParseJSON<BWItem>(raw);
    if (!item) {
      throw new Error(`Secret "${key}" not found in Bitwarden`);
    }
    await this.bw(['delete', 'item', item.id, '--nointeraction']);
  }

  async healthCheck(): Promise<SecretProviderHealth> {
    try {
      const raw = await this.bw(['status', '--nointeraction']);
      const status = this.tryParseJSON<BWStatus>(raw);

      if (!status) {
        return { healthy: false, message: 'Could not parse bw status output' };
      }

      if (status.status === 'unauthenticated') {
        return { healthy: false, message: 'Bitwarden: not logged in. Run `bw login`.' };
      }
      if (status.status === 'locked') {
        return { healthy: false, message: 'Bitwarden: vault is locked. Run `bw unlock`.' };
      }

      return {
        healthy: true,
        message: `Bitwarden: unlocked (${status.userEmail})`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('command not found') || msg.includes('ENOENT')) {
        return {
          healthy: false,
          message: 'Bitwarden CLI (bw) not found. Install it: npm i -g @bitwarden/cli',
        };
      }
      return { healthy: false, message: `Bitwarden health check failed: ${msg}` };
    }
  }
}
