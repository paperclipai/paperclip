/**
 * Wallet provider factory
 *
 * Centralized chain normalization and provider construction.
 */

import type { BaseWalletProvider } from './base-provider.js';
import type { ChainType } from '../types.js';
import { CkEthProvider } from './cketh-provider.js';
import { PolkadotProvider } from './polkadot-provider.js';
import { SolanaProvider } from './solana-provider.js';
import { IcpProvider } from './icp-provider.js';
import { ArweaveProvider } from './arweave-provider.js';

/**
 * Provider factory options
 */
export interface ProviderFactoryOptions {
  isTestnet?: boolean;
  rpcUrl?: string;
}

/**
 * Normalize chain aliases to canonical internal chain names.
 */
export function normalizeWalletChain(chain: string): ChainType {
  switch (chain.toLowerCase()) {
    case 'cketh':
    case 'eth':
    case 'ethereum':
      return 'cketh';
    case 'polkadot':
    case 'dot':
      return 'polkadot';
    case 'solana':
    case 'sol':
      return 'solana';
    case 'icp':
      return 'icp';
    case 'ar':
    case 'arweave':
      return 'arweave';
    default:
      throw new Error(`Unsupported chain: ${chain}`);
  }
}

/**
 * Create a wallet provider for a chain.
 */
export function createWalletProvider(
  chain: string,
  options: ProviderFactoryOptions = {}
): BaseWalletProvider {
  const normalized = normalizeWalletChain(chain);
  const isTestnet = options.isTestnet ?? false;

  switch (normalized) {
    case 'cketh':
      return new CkEthProvider({
        chain: 'cketh',
        rpcUrl: options.rpcUrl || CkEthProvider.getDefaultRpcUrl(isTestnet),
        isTestnet,
      });
    case 'polkadot':
      return new PolkadotProvider({
        chain: 'polkadot',
        rpcUrl: options.rpcUrl || (isTestnet ? 'wss://westend-rpc.polkadot.io' : 'wss://rpc.polkadot.io'),
        isTestnet,
      });
    case 'solana':
      return new SolanaProvider({
        chain: 'solana',
        rpcUrl: options.rpcUrl || (isTestnet ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com'),
        isTestnet,
      });
    case 'icp':
      return new IcpProvider({
        chain: 'icp',
        rpcUrl: options.rpcUrl || IcpProvider.getDefaultRpcUrl(),
        isTestnet,
      });
    case 'arweave':
      return new ArweaveProvider({
        chain: 'arweave',
        rpcUrl: options.rpcUrl || ArweaveProvider.getDefaultRpcUrl(),
        isTestnet,
      });
  }
}
