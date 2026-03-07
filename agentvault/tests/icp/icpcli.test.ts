/**
 * Tests for icp-cli wrapper
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execa before importing the module
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import * as icpcli from '../../src/icp/icpcli.js';
import { execa } from 'execa';

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('icp build', () => {
  it('should call icp build with common args', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'Build succeeded', stderr: '' });

    const result = await icpcli.build({
      environment: 'local',
      canisters: ['agent_vault'],
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['build', '-e', 'local', 'agent_vault'],
      expect.objectContaining({ reject: false }),
    );
    expect(result.success).toBe(true);
  });

  it('should call icp build with no args for build all', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.build();

    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['build'],
      expect.any(Object),
    );
  });
});

describe('icp deploy', () => {
  it('should call icp deploy with environment and mode', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'Deployed', stderr: '' });

    const result = await icpcli.deploy({
      environment: 'production',
      mode: 'upgrade',
      identity: 'main-wallet',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['deploy', '-e', 'production', '--identity', 'main-wallet', '-m', 'upgrade'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should handle deploy failure', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Insufficient cycles' });

    const result = await icpcli.deploy({ environment: 'ic' });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Insufficient cycles');
  });

  it('should support project root override', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.deploy({ projectRoot: '/my/project' });

    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['deploy', '--project-root-override', '/my/project'],
      expect.objectContaining({ cwd: '/my/project' }),
    );
  });
});

describe('icp canister operations', () => {
  it('should get canister status', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'Status: Running', stderr: '' });

    const result = await icpcli.canisterStatus({
      canister: 'rrkah-fqaaa-aaaaa-aaaaa-cai',
      environment: 'ic',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['canister', 'status', 'rrkah-fqaaa-aaaaa-aaaaa-cai', '-e', 'ic'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should call canister method', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '(variant { ok = "hello" })', stderr: '' });

    const result = await icpcli.canisterCall({
      canister: 'rrkah-fqaaa-aaaaa-aaaaa-cai',
      method: 'getAgentStatus',
      args: '()',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['canister', 'call', 'rrkah-fqaaa-aaaaa-aaaaa-cai', 'getAgentStatus', '()'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should list canisters', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'agent_vault', stderr: '' });

    const result = await icpcli.canisterList();
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['canister', 'list'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should start a canister', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.canisterStart('rrkah-fqaaa-aaaaa-aaaaa-cai');
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['canister', 'start', 'rrkah-fqaaa-aaaaa-aaaaa-cai'],
      expect.any(Object),
    );
  });

  it('should stop a canister', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.canisterStop('rrkah-fqaaa-aaaaa-aaaaa-cai');
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['canister', 'stop', 'rrkah-fqaaa-aaaaa-aaaaa-cai'],
      expect.any(Object),
    );
  });
});

describe('icp cycles', () => {
  it('should check cycle balance', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '100_000_000_000', stderr: '' });

    const result = await icpcli.cyclesBalance({
      canister: 'rrkah-fqaaa-aaaaa-aaaaa-cai',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['cycles', 'balance', 'rrkah-fqaaa-aaaaa-aaaaa-cai'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should mint cycles', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.cyclesMint({ amount: '100T' });
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['cycles', 'mint', '100T'],
      expect.any(Object),
    );
  });

  it('should transfer cycles', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.cyclesTransfer({
      amount: '10T',
      to: 'rrkah-fqaaa-aaaaa-aaaaa-cai',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['cycles', 'transfer', '10T', '--to', 'rrkah-fqaaa-aaaaa-aaaaa-cai'],
      expect.any(Object),
    );
  });
});

describe('icp identity', () => {
  it('should list identities', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'default\nmain-wallet', stderr: '' });

    const result = await icpcli.identityList();
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['identity', 'list'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should create new identity', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.identityNew({ name: 'test-wallet' });
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['identity', 'new', 'test-wallet'],
      expect.any(Object),
    );
  });

  it('should export identity', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '-----BEGIN EC PRIVATE KEY-----', stderr: '' });

    const result = await icpcli.identityExport({ name: 'default' });
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('BEGIN EC PRIVATE KEY');
  });

  it('should import identity from PEM file', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.identityImport({ name: 'imported', pemFile: '/tmp/key.pem' });
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['identity', 'import', 'imported', '/tmp/key.pem'],
      expect.any(Object),
    );
  });

  it('should get principal', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'rwlgt-iiaaa-aaaaa-aaaaa-cai', stderr: '' });

    const result = await icpcli.identityPrincipal();
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('rwlgt');
  });
});

describe('icp network', () => {
  it('should start local network', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'Network started', stderr: '' });

    const result = await icpcli.networkStart();
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['network', 'start'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should stop local network', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.networkStop();
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['network', 'stop'],
      expect.any(Object),
    );
  });

  it('should get network status', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'Running', stderr: '' });

    const result = await icpcli.networkStatus();
    expect(result.success).toBe(true);
  });

  it('should ping network', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'OK', stderr: '' });

    const result = await icpcli.networkPing();
    expect(result.success).toBe(true);
  });
});

describe('icp sync', () => {
  it('should synchronize canisters', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'Sync complete', stderr: '' });

    const result = await icpcli.sync({ environment: 'local' });
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['sync', '-e', 'local'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });
});

describe('icp token', () => {
  it('should get token balance', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '100.0 ICP', stderr: '' });

    const result = await icpcli.tokenBalance();
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['token', 'balance'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should transfer tokens', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'Transfer complete', stderr: '' });

    await icpcli.tokenTransfer({
      amount: '1.5',
      to: 'rwlgt-iiaaa-aaaaa-aaaaa-cai',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['token', 'transfer', '1.5', '--to', 'rwlgt-iiaaa-aaaaa-aaaaa-cai'],
      expect.any(Object),
    );
  });

  it('should specify token canister for ICRC-1 tokens', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '500', stderr: '' });

    await icpcli.tokenBalance({
      canister: 'mxzaz-hqaaa-aaaar-qaada-cai',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['token', 'balance', '--canister', 'mxzaz-hqaaa-aaaar-qaada-cai'],
      expect.any(Object),
    );
  });
});

describe('icp environment', () => {
  it('should list environments', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'local\ndev\nstaging', stderr: '' });

    const result = await icpcli.environmentList();
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['environment', 'list'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });
});

describe('icp project', () => {
  it('should show project info', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'environments:\n  local:', stderr: '' });

    const result = await icpcli.projectShow();
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['project', 'show'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });
});

describe('error handling', () => {
  it('should handle execa throwing for any command', async () => {
    mockExeca.mockRejectedValue(new Error('ENOENT'));

    const result = await icpcli.build();
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('ENOENT');
    expect(result.exitCode).toBe(1);
  });

  it('should pass debug flag', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.deploy({ debug: true });
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['deploy', '--debug'],
      expect.any(Object),
    );
  });

  it('should pass identity password file', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icpcli.deploy({ identityPasswordFile: '/tmp/pass.txt' });
    expect(mockExeca).toHaveBeenCalledWith(
      'icp',
      ['deploy', '--identity-password-file', '/tmp/pass.txt'],
      expect.any(Object),
    );
  });
});
