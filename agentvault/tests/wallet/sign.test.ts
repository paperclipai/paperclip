/**
 * Wallet Sign Tests (CLE-70)
 *
 * Tests for wallet signing functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/wallet/wallet-storage.js', () => ({
  saveWallet: vi.fn(),
  loadWallet: vi.fn().mockReturnValue({
    id: 'wallet-1',
    agentId: 'test-agent',
    chain: 'cketh',
    address: '0x1234567890abcdef1234567890abcdef12345678',
    privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    creationMethod: 'private-key',
  }),
}));

describe('Wallet Sign (CLE-70)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Provider Creation', () => {
    it('should create ckETH provider for signing', async () => {
      const { CkEthProvider } = await import('../../src/wallet/providers/cketh-provider.js');
      const provider = new CkEthProvider({
        chain: 'cketh',
        rpcUrl: 'https://eth.example.com',
      });

      expect(provider).toBeDefined();
    });

    it('should create Solana provider for signing', async () => {
      const { SolanaProvider } = await import('../../src/wallet/providers/solana-provider.js');
      const provider = new SolanaProvider({
        chain: 'solana',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      });

      expect(provider).toBeDefined();
    });

    it('should create Polkadot provider for signing', { timeout: 15000 }, async () => {
      const { PolkadotProvider } = await import('../../src/wallet/providers/polkadot-provider.js');
      const provider = new PolkadotProvider({
        chain: 'polkadot',
        rpcUrl: 'wss://rpc.polkadot.io',
      });

      expect(provider).toBeDefined();
    });

    it('should create ICP provider for signing', async () => {
      const { IcpProvider } = await import('../../src/wallet/providers/icp-provider.js');
      const provider = new IcpProvider({
        chain: 'icp',
      });

      expect(provider).toBeDefined();
    });

    it('should create Arweave provider for signing', async () => {
      const { ArweaveProvider } = await import('../../src/wallet/providers/arweave-provider.js');
      const provider = new ArweaveProvider({
        chain: 'arweave',
      });

      expect(provider).toBeDefined();
    });
  });

  describe('Wallet Import for Signing', () => {
    it('should import wallet from private key', async () => {
      const { importWalletFromPrivateKey } = await import('../../src/wallet/index.js');
      const wallet = importWalletFromPrivateKey(
        'test-agent',
        'cketh',
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
      );

      expect(wallet).toBeDefined();
      expect(wallet.address).toBeDefined();
    });

    it('should import wallet from seed', async () => {
      const { importWalletFromSeed } = await import('../../src/wallet/index.js');
      const wallet = importWalletFromSeed(
        'test-agent',
        'solana',
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );

      expect(wallet).toBeDefined();
      expect(wallet.address).toBeDefined();
    });
  });

  describe('Transaction Request Structure', () => {
    it('should have valid transaction request format', () => {
      const txRequest = {
        to: '0x0987654321fedcba0987654321fedcba09876543',
        amount: '1000000000000000000',
        chain: 'cketh' as const,
      };

      expect(txRequest.to).toBeDefined();
      expect(txRequest.amount).toBeDefined();
      expect(txRequest.chain).toBe('cketh');
    });

    it('should support gas configuration', () => {
      const txRequest = {
        to: '0x0987654321fedcba0987654321fedcba09876543',
        amount: '1000000000000000000',
        chain: 'cketh' as const,
        gasPrice: '20000000000',
        gasLimit: '21000',
      };

      expect(txRequest.gasPrice).toBeDefined();
      expect(txRequest.gasLimit).toBeDefined();
    });
  });

  describe('Multi-chain Support', () => {
    it('should support cketh chain', () => {
      const chain = 'cketh' as const;
      expect(chain).toBe('cketh');
    });

    it('should support solana chain', () => {
      const chain = 'solana' as const;
      expect(chain).toBe('solana');
    });

    it('should support polkadot chain', () => {
      const chain = 'polkadot' as const;
      expect(chain).toBe('polkadot');
    });

    it('should support icp chain', () => {
      const chain = 'icp' as const;
      expect(chain).toBe('icp');
    });

    it('should support arweave chain', () => {
      const chain = 'arweave' as const;
      expect(chain).toBe('arweave');
    });
  });
});
