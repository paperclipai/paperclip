import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/wallet/wallet-storage.js', () => ({
  saveWallet: vi.fn(),
  loadWallet: vi.fn(),
  deleteWallet: vi.fn(),
  listWallets: vi.fn().mockReturnValue([]),
  walletExists: vi.fn().mockReturnValue(false),
}));

describe('Wallet multi-chain support (ICP + Arweave)', () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const privateKey = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('generates ICP wallet with principal address', async () => {
    const { generateWallet } = await import('../../src/wallet/index.js');
    const wallet = generateWallet('agent-1', 'icp');

    expect(wallet.chain).toBe('icp');
    expect(wallet.address).toMatch(/^[a-z0-9]{5}(-[a-z0-9]{3,5})+$/);
  });

  it('imports ICP wallet from private key', async () => {
    const { importWalletFromPrivateKey } = await import('../../src/wallet/index.js');
    const wallet = importWalletFromPrivateKey('agent-1', 'icp', privateKey);

    expect(wallet.chain).toBe('icp');
    expect(wallet.address).toMatch(/^[a-z0-9]{5}(-[a-z0-9]{3,5})+$/);
  });

  it('generates Arweave wallet with base64url address', async () => {
    const { generateWallet } = await import('../../src/wallet/index.js');
    const wallet = generateWallet('agent-1', 'arweave');

    expect(wallet.chain).toBe('arweave');
    expect(wallet.address).toMatch(/^[a-zA-Z0-9_-]{43}$/);
  });

  it('imports Arweave wallet from private key', async () => {
    const { importWalletFromPrivateKey } = await import('../../src/wallet/index.js');
    const wallet = importWalletFromPrivateKey('agent-1', 'arweave', privateKey);

    expect(wallet.chain).toBe('arweave');
    expect(wallet.address).toMatch(/^[a-zA-Z0-9_-]{43}$/);
  });

  it('derives deterministic ICP and Arweave addresses from mnemonic', async () => {
    const { importWalletFromSeed } = await import('../../src/wallet/index.js');
    const icpA = importWalletFromSeed('agent-1', 'icp', mnemonic);
    const icpB = importWalletFromSeed('agent-1', 'icp', mnemonic);
    const arA = importWalletFromSeed('agent-1', 'arweave', mnemonic);
    const arB = importWalletFromSeed('agent-1', 'arweave', mnemonic);

    expect(icpA.address).toBe(icpB.address);
    expect(arA.address).toBe(arB.address);
  });

  it('creates providers for ICP and Arweave and can fetch balance shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { createWalletProvider } = await import('../../src/wallet/index.js');

    const icpProvider = createWalletProvider('icp');
    await icpProvider.connect();
    const icpBalance = await icpProvider.getBalance('aaaaa-aa');

    const arweaveProvider = createWalletProvider('arweave');
    await arweaveProvider.connect();
    const arweaveBalance = await arweaveProvider.getBalance('T3A5Fj9q9KpM8x0Z0Q3n9ULwQxV9PjWQ3o4K2i5wQpM');

    expect(icpBalance.chain).toBe('icp');
    expect(icpBalance.denomination).toBe('ICP');
    expect(arweaveBalance.chain).toBe('arweave');
    expect(arweaveBalance.denomination).toBe('AR');
  });
});
