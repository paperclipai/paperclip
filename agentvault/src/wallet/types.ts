/**
 * Types for wallet operations
 */

/**
 * Supported blockchain types
 */
export type ChainType = 'cketh' | 'polkadot' | 'solana' | 'icp' | 'arweave';

/**
 * AES-256-GCM encrypted ciphertext bundle
 */
export interface EncryptedCiphertext {
  /** 12-byte IV as hex */
  iv: string;
  /** AES-256-GCM ciphertext as hex */
  ciphertext: string;
  /** 16-byte GCM authentication tag as hex */
  tag: string;
}

/**
 * Encrypted wallet key bundle stored at rest.
 * The AES key is derived from the mnemonic + salt via PBKDF2-SHA256.
 */
export interface EncryptedKeyBundle {
  /** Schema version for forward-compatibility */
  version: 1;
  /** 32-byte random per-wallet PBKDF2 salt as hex */
  salt: string;
  /** Encrypted private key (secp256k1 or ed25519) */
  privateKey?: EncryptedCiphertext;
  /** Encrypted BIP39 mnemonic */
  mnemonic?: EncryptedCiphertext;
}

/**
 * Wallet creation methods
 *
 * 'hsm' indicates the key was generated inside a hardware secure element or
 * Trusted Execution Environment (Ledger / Intel SGX).  No private key or
 * mnemonic is ever present in a wallet created with this method.
 */
export type WalletCreationMethod = 'seed' | 'private-key' | 'mnemonic' | 'hsm';

/**
 * Derivation path for BIP39 seed phrases
 */
export type DerivationPath = string;

/**
 * Wallet data structure (stored encrypted)
 */
export interface WalletData {
  /** Unique wallet ID */
  id: string;
  /** Associated agent ID (for per-agent isolation) */
  agentId: string;
  /** Blockchain network */
  chain: ChainType;
  /** Public address */
  address: string;
  /** Encrypted private key (if available) */
  privateKey?: string;
  /** Encrypted mnemonic phrase (if available) */
  mnemonic?: string;
  /** BIP39 derivation path */
  seedDerivationPath?: DerivationPath;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Wallet creation method */
  creationMethod: WalletCreationMethod;
  /** Chain-specific metadata */
  chainMetadata?: Record<string, any>;
  /** AES-256-GCM encrypted key bundle (replaces plaintext privateKey/mnemonic at rest) */
  encryptedSecrets?: EncryptedKeyBundle;
}

/**
 * Wallet connection status
 */
export interface WalletConnection {
  /** Wallet ID */
  walletId: string;
  /** Connection status */
  connected: boolean;
  /** Chain-specific provider instance */
  provider: any;
  /** Connection timestamp */
  connectedAt?: number;
}

/**
 * Transaction data
 */
export interface Transaction {
  /** Transaction hash */
  hash: string;
  /** From address */
  from: string;
  /** To address */
  to: string;
  /** Amount (as string to handle large numbers) */
  amount: string;
  /** Blockchain network */
  chain: ChainType;
  /** Transaction timestamp */
  timestamp: number;
  /** Transaction status */
  status: 'pending' | 'confirmed' | 'failed';
  /** Transaction fee */
  fee?: string;
  /** Additional data (memo, etc.) */
  data?: any;
}

/**
 * Wallet balance
 */
export interface Balance {
  /** Amount (as string to handle large numbers) */
  amount: string;
  /** Denomination (ETH, DOT, SOL, etc.) */
  denomination: string;
  /** Blockchain network */
  chain: ChainType;
  /** Wallet address */
  address: string;
  /** Block number (if available) */
  blockNumber?: number;
}

/**
 * Transaction request
 */
export interface TransactionRequest {
  /** Destination address */
  to: string;
  /** Amount to send (as string) */
  amount: string;
  /** Chain network */
  chain: ChainType;
  /** Optional memo (Solana) */
  memo?: string;
  /** Optional gas price (Ethereum/Polkadot) */
  gasPrice?: string;
  /** Optional gas limit (Ethereum/Polkadot) */
  gasLimit?: string;
}

/**
 * Signed transaction data
 */
export interface SignedTransaction {
  /** Signed transaction hash */
  txHash: string;
  /** Raw signed transaction (hex/base58) */
  signedTx: string;
  /** Signature */
  signature?: string;
  /** Transaction request that was signed */
  request: TransactionRequest;
}

/**
 * Wallet creation options
 */
export interface WalletCreationOptions {
  /** Agent ID to associate wallet with */
  agentId: string;
  /** Blockchain network */
  chain: ChainType;
  /** Wallet creation method */
  method: WalletCreationMethod;
  /** Seed phrase (for 'seed' and 'mnemonic' methods) */
  seedPhrase?: string;
  /** Private key (for 'private-key' method) */
  privateKey?: string;
  /** BIP39 derivation path */
  derivationPath?: DerivationPath;
  /** Optional custom wallet ID */
  walletId?: string;
  /** Optional chain-specific metadata */
  chainMetadata?: Record<string, any>;
}

/**
 * Options for creating a wallet via HSM / TEE keygen.
 * No mnemonic or private key is supplied – the device generates them internally.
 */
export interface HsmWalletCreationOptions {
  /** Agent ID to associate the wallet with. */
  agentId: string;
  /** Blockchain network. */
  chain: ChainType;
  /** HSM backend to use ('ledger' | 'sgx'). */
  hsmBackend: 'ledger' | 'sgx';
  /** BIP32 / SLIP10 derivation path (defaults to chain-standard path). */
  derivationPath?: string;
  /** Optional custom wallet ID. */
  walletId?: string;
  /** Backend-specific options (e.g. SGX socket path). */
  hsmOptions?: Record<string, string>;
}

/**
 * Wallet storage options
 */
export interface WalletStorageOptions {
  /** Base directory for wallet storage */
  baseDir?: string;
  /** Enable encryption */
  encrypt?: boolean;
  /**
   * BIP39 mnemonic used to derive the AES-256-GCM storage key via PBKDF2.
   * When provided, private keys and mnemonics are encrypted at rest in
   * encryptedSecrets and the plaintext fields are omitted from the file.
   */
  encryptionKey?: string;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  /** Blockchain network */
  chain: ChainType;
  /** RPC endpoint URL */
  rpcUrl?: string;
  /** Testnet or mainnet */
  isTestnet?: boolean;
  /** API key (if required) */
  apiKey?: string;
}
