import { beforeEach, describe, expect, it, vi } from 'vitest';

const walletMocks = vi.hoisted(() => ({
  generateWallet: vi.fn(),
  importWalletFromMnemonic: vi.fn(),
  importWalletFromPrivateKey: vi.fn(),
}));

vi.mock('../../../src/wallet/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/wallet/index.js')>(
    '../../../src/wallet/index.js'
  );

  return {
    ...actual,
    generateWallet: walletMocks.generateWallet,
    importWalletFromMnemonic: walletMocks.importWalletFromMnemonic,
    importWalletFromPrivateKey: walletMocks.importWalletFromPrivateKey,
  };
});

import {
  handleGenerateNonInteractive,
  handleImportNonInteractive,
  normalizeChain,
} from '../../../cli/commands/wallet.js';

describe('wallet command chain support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletMocks.generateWallet.mockImplementation((_agentId: string, chain: string) => ({
      id: 'wallet-1',
      chain,
      address: chain === 'icp' ? 'aaaaa-aa' : 'dGVzdF9hZHJlc3Mtd2l0aC1iYXNlNjR1cmxjaGFyczEyMw',
      createdAt: Date.now(),
    }));
    walletMocks.importWalletFromMnemonic.mockImplementation((_agentId: string, chain: string) => ({
      id: 'wallet-2',
      chain,
      address: chain === 'icp' ? 'bbbbb-bb' : 'YW5vdGhlcl9hZGRyZXNzLWFyd2VhdmUxMjM0NTY3ODkwMTI',
      createdAt: Date.now(),
    }));
    walletMocks.importWalletFromPrivateKey.mockImplementation((_agentId: string, chain: string) => ({
      id: 'wallet-3',
      chain,
      address: chain === 'icp' ? 'ccccc-cc' : 'cHJpdmF0ZWtleV9hZGRyZXNzLWFyd2VhdmUxMjM0NTY3ODk',
      createdAt: Date.now(),
    }));
  });

  it('normalizes icp chain alias', () => {
    expect(normalizeChain('icp')).toBe('icp');
  });

  it('normalizes arweave aliases', () => {
    expect(normalizeChain('arweave')).toBe('arweave');
    expect(normalizeChain('ar')).toBe('arweave');
  });

  it('generates wallet for icp chain', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleGenerateNonInteractive({
      agentId: 'agent-1',
      chain: 'icp',
      json: true,
    });

    expect(walletMocks.generateWallet).toHaveBeenCalledWith('agent-1', 'icp');
    logSpy.mockRestore();
  });

  it('generates wallet for arweave chain', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleGenerateNonInteractive({
      agentId: 'agent-1',
      chain: 'arweave',
      json: true,
    });

    expect(walletMocks.generateWallet).toHaveBeenCalledWith('agent-1', 'arweave');
    logSpy.mockRestore();
  });

  it('imports mnemonic wallet for icp chain', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    await handleImportNonInteractive({
      agentId: 'agent-1',
      chain: 'icp',
      mnemonic,
      json: true,
    });

    expect(walletMocks.importWalletFromMnemonic).toHaveBeenCalledWith('agent-1', 'icp', mnemonic);
    logSpy.mockRestore();
  });

  it('imports private-key wallet for arweave chain', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const privateKey = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

    await handleImportNonInteractive({
      agentId: 'agent-1',
      chain: 'arweave',
      privateKey,
      json: true,
    });

    expect(walletMocks.importWalletFromPrivateKey).toHaveBeenCalledWith('agent-1', 'arweave', privateKey);
    logSpy.mockRestore();
  });
});
