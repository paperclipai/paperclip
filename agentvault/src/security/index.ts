/**
 * Security module for AgentVault
 *
 * This module provides encryption, decryption, and key management
 * using VetKeys for threshold key derivation.
 */

export * from './types.js';

// VetKeysClient is exported from types.js, avoid re-exporting from vetkeys.js
export { VetKeysClient } from './types.js';

// Re-export decryptJSON and bundle encryption from vetkeys.js
export {
  decryptJSON,
  encryptBundleWithVetKeys,
  decryptBundle,
  isVetKeysEncryptedBundle,
} from './vetkeys.js';

// Multi-sig approval workflows
export * from './multisig.js';

// TOTP (RFC 6238) — pure-Node implementation for Authy / Google Authenticator
export * from './totp.js';

// Multi-Factor Agent Approval — TOTP + nonce + one-time link + rate-limit + anomaly
export * from './mfa-approval.js';

// WebAuthn / Biometric fallback — P-256 device keys, Secure Enclave simulation
export * from './webauthn.js';

// ICP On-Chain Audit Log — tamper-evident on-chain event storage
export * from './icp-audit.js';

// HashiCorp Vault integration
export { VaultClient } from '../vault/client.js';
export type {
  VaultConfig,
  VaultSecret,
  VaultSecretMetadata,
  VaultOperationResult,
  VaultHealthStatus,
  AgentVaultPolicy,
  AgentVaultInitOptions,
} from '../vault/types.js';
