/**
 * Tests for the Bitwarden CLI secret provider.
 *
 * The `bw` binary is mocked via vi.mock so no real Bitwarden account or
 * network connection is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BitwardenProvider } from '../../src/vault/bitwarden.js';

// ---------------------------------------------------------------------------
// Mock node:child_process so we never shell out to a real `bw` binary
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util');
  return {
    ...actual,
    promisify: (fn: unknown) => {
      // Return a promisified version that uses the mocked execFile underneath
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (...args: any[]) => {
        return new Promise((resolve, reject) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (fn as any)(...args, (err: Error | null, stdout: string, stderr: string) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          });
        });
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Helper to configure the execFile mock return for each test
// ---------------------------------------------------------------------------

async function getMockedExecFile() {
  const mod = await import('node:child_process');
  return mod.execFile as unknown as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------

describe('BitwardenProvider – constructor', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('throws when BW_SESSION is not set and no session is provided', () => {
    delete process.env.BW_SESSION;
    expect(() => new BitwardenProvider({ agentId: 'test-agent' })).toThrow(
      'Bitwarden session key is required',
    );
  });

  it('reads BW_SESSION from the environment', () => {
    process.env.BW_SESSION = 'env-session-token';
    expect(() => new BitwardenProvider({ agentId: 'test-agent' })).not.toThrow();
  });

  it('accepts an explicit session via config', () => {
    delete process.env.BW_SESSION;
    expect(
      () => new BitwardenProvider({ agentId: 'test-agent', session: 'explicit-token' }),
    ).not.toThrow();
  });
});

describe('BitwardenProvider – healthCheck', () => {
  it('reports healthy when bw status returns unlocked', async () => {
    const execFile = await getMockedExecFile();
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({
        status: 'unlocked',
        userEmail: 'user@example.com',
        userId: 'uid-123',
        serverUrl: 'https://vault.bitwarden.com',
        lastSync: new Date().toISOString(),
      }), '');
    });

    const provider = new BitwardenProvider({ agentId: 'agent1', session: 'tok' });
    const health = await provider.healthCheck();

    expect(health.healthy).toBe(true);
    expect(health.message).toContain('unlocked');
  });

  it('reports unhealthy when bw status returns locked', async () => {
    const execFile = await getMockedExecFile();
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ status: 'locked', userEmail: '', userId: '', serverUrl: null, lastSync: '' }), '');
    });

    const provider = new BitwardenProvider({ agentId: 'agent1', session: 'tok' });
    const health = await provider.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.message).toMatch(/locked/i);
  });

  it('reports unhealthy and provides install hint when bw is missing', async () => {
    const execFile = await getMockedExecFile();
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
      const err = new Error('ENOENT: bw not found') as Error & { stderr?: string };
      err.stderr = 'ENOENT: bw not found';
      cb(err, '', '');
    });

    const provider = new BitwardenProvider({ agentId: 'agent1', session: 'tok' });
    const health = await provider.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.message).toMatch(/not found|install/i);
  });
});

describe('BitwardenProvider – item name convention', () => {
  it('namespaces secrets under agentvault/<agentId>/<key>', async () => {
    // We verify the naming convention by checking what args are passed to execFile
    const execFile = await getMockedExecFile();
    const capturedArgs: string[][] = [];

    execFile.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: Function) => {
      capturedArgs.push(args);
      // Return "not found" to simulate a missing item on the initial get
      const err = new Error('Not found') as Error & { stderr?: string };
      err.stderr = 'Not found.';
      cb(err, '', '');
    });

    const provider = new BitwardenProvider({ agentId: 'my-agent', session: 'tok' });
    // getSecret will call `bw get item agentvault/my-agent/api_binance`
    const result = await provider.getSecret('api_binance');

    expect(result).toBeNull();
    expect(capturedArgs[0]).toContain('agentvault/my-agent/api_binance');
  });
});

describe('BitwardenProvider – listSecrets', () => {
  it('returns keys stripped of the agent namespace prefix', async () => {
    const execFile = await getMockedExecFile();
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
      const items = [
        { id: '1', name: 'agentvault/my-agent/api_binance', type: 2, notes: 'val1', object: 'item' },
        { id: '2', name: 'agentvault/my-agent/openai_key', type: 2, notes: 'val2', object: 'item' },
        { id: '3', name: 'agentvault/other-agent/unrelated', type: 2, notes: 'x', object: 'item' },
      ];
      cb(null, JSON.stringify(items), '');
    });

    const provider = new BitwardenProvider({ agentId: 'my-agent', session: 'tok' });
    const keys = await provider.listSecrets();

    expect(keys).toContain('api_binance');
    expect(keys).toContain('openai_key');
    // Should NOT include secrets from another agent
    expect(keys).not.toContain('unrelated');
    expect(keys.length).toBe(2);
  });

  it('returns empty array when bw returns no items', async () => {
    const execFile = await getMockedExecFile();
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '[]', '');
    });

    const provider = new BitwardenProvider({ agentId: 'my-agent', session: 'tok' });
    const keys = await provider.listSecrets();
    expect(keys).toEqual([]);
  });
});
