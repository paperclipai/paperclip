/**
 * Wallet History Tests (CLE-69)
 *
 * Tests for wallet history functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/wallet/wallet-storage.js', () => ({
  listWallets: vi.fn().mockReturnValue(['wallet-1', 'wallet-2']),
  loadWallet: vi.fn().mockImplementation((agentId: string, walletId: string) => ({
    id: walletId,
    agentId,
    chain: 'cketh',
    address: '0x1234567890abcdef1234567890abcdef12345678',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    creationMethod: 'seed',
  })),
}));

describe('Wallet History (CLE-69)', () => {
  const testAgentId = 'test-agent';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listAgentWallets', () => {
    it('should return array of wallet IDs for agent', { timeout: 15000 }, async () => {
      const { listAgentWallets } = await import('../../src/wallet/index.js');
      const wallets = listAgentWallets(testAgentId);

      expect(Array.isArray(wallets)).toBe(true);
      expect(wallets.length).toBeGreaterThan(0);
    });
  });

  describe('getWallet', () => {
    it('should return wallet data for valid ID', async () => {
      const { getWallet } = await import('../../src/wallet/index.js');
      const wallet = getWallet(testAgentId, 'wallet-1');

      expect(wallet).toBeDefined();
      expect(wallet?.id).toBe('wallet-1');
    });

    it('should include required wallet fields', async () => {
      const { getWallet } = await import('../../src/wallet/index.js');
      const wallet = getWallet(testAgentId, 'wallet-1');

      expect(wallet?.agentId).toBeDefined();
      expect(wallet?.chain).toBeDefined();
      expect(wallet?.address).toBeDefined();
      expect(wallet?.createdAt).toBeDefined();
    });
  });

  describe('Provider History', () => {
    it('should create ckETH provider with config', async () => {
      const { CkEthProvider } = await import('../../src/wallet/providers/cketh-provider.js');
      const provider = new CkEthProvider({
        chain: 'cketh',
        rpcUrl: 'https://eth.example.com',
      });

      expect(provider).toBeDefined();
    });

    it('should create Solana provider with config', async () => {
      const { SolanaProvider } = await import('../../src/wallet/providers/solana-provider.js');
      const provider = new SolanaProvider({
        chain: 'solana',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      });

      expect(provider).toBeDefined();
    });

    it('should create Polkadot provider with config', async () => {
      const { PolkadotProvider } = await import('../../src/wallet/providers/polkadot-provider.js');
      const provider = new PolkadotProvider({
        chain: 'polkadot',
        rpcUrl: 'wss://rpc.polkadot.io',
      });

      expect(provider).toBeDefined();
    });
  });
});
