/**
 * Wallet Module
 *
 * Complete wallet management system for ckETH, Polkadot, Solana, ICP, and Arweave.
 * Provides per-agent wallet isolation, encryption, and CBOR serialization.
 */

// Types
export * from './types.js';

// CBOR Serialization
export {
  serializeWallet,
  deserializeWallet,
  serializeTransaction,
  deserializeTransaction,
  serializeTransactionRequest,
  deserializeTransactionRequest,
  serializeSignedTransaction,
  deserializeSignedTransaction,
  validateCborData,
} from './cbor-serializer.js';

// Wallet Storage
export {
  getWalletBaseDir,
  getAgentWalletDir,
  getWalletFilePath,
  ensureWalletDirectories,
  saveWallet,
  loadWallet,
  deleteWallet,
  listWallets,
  listAgents,
  walletExists,
  getWalletStats,
  backupWallets,
  restoreWallets,
  clearWallets,
  getWalletStorageSize,
} from './wallet-storage.js';

// Key Derivation
export {
  parseDerivationPath,
  buildDerivationPath,
  validateSeedPhrase,
  generateSeedFromMnemonic,
  generateMnemonic,
  getDefaultDerivationPath,
  deriveWalletKey,
} from './key-derivation.js';

// Wallet Crypto (key generation + at-rest encryption)
export {
  secp256k1KeypairFromSeed,
  ed25519KeypairFromSeed,
  deriveStorageKey,
  encryptSecret,
  decryptSecret,
  encryptWalletSecrets,
  decryptWalletSecrets,
} from './wallet-crypto.js';

// Wallet Manager
export {
  createWallet,
  importWalletFromPrivateKey,
  importWalletFromSeed,
  importWalletFromMnemonic,
  generateWallet,
  createWalletWithHsm,
  getWallet,
  listAgentWallets,
  hasWallet,
  removeWallet,
  clearAgentWallets,
  cacheWalletConnection,
  getCachedConnection,
  clearCachedConnection,
  validateSeedPhraseWrapper,
} from './wallet-manager.js';

// HSM / TEE keygen
export {
  LedgerHsmProvider,
  SgxHsmProvider,
  isLedgerAvailable,
  isSgxAvailable,
  isHsmAvailable,
  createHsmProvider,
  HsmError,
  HsmNotAvailableError,
  HsmCurveUnsupportedError,
  HsmOperationError,
} from './hsm/index.js';
export type {
  HsmBackend,
  HsmCurve,
  HsmProvider,
  HsmPublicKeyResult,
  HsmSignatureResult,
  HsmWalletMetadata,
} from './hsm/index.js';

// Providers
export { BaseWalletProvider } from './providers/base-provider.js';
export { CkEthProvider } from './providers/cketh-provider.js';
export { PolkadotProvider } from './providers/polkadot-provider.js';
export { SolanaProvider } from './providers/solana-provider.js';
export { IcpProvider } from './providers/icp-provider.js';
export { ArweaveProvider } from './providers/arweave-provider.js';
export { createWalletProvider, normalizeWalletChain } from './providers/provider-factory.js';
