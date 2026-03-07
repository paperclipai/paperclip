/**
 * Key Derivation Module
 *
 * Implements BIP39 seed phrase derivation for wallet keys.
 * Supports multiple derivation paths for different blockchains.
 *
 * Curve usage:
 *   secp256k1 – Ethereum / ckETH / Polkadot  (@noble/curves/secp256k1)
 *   Ed25519   – ICP / Arweave                (@noble/curves/ed25519)
 *   Ed25519   – Solana                       (@solana/web3.js Keypair for base58)
 */

import * as bip39 from 'bip39';
import * as crypto from 'node:crypto';
import { encodeAddress } from '@polkadot/util-crypto';
import type { WalletCreationMethod } from './types.js';
import { Keypair } from '@solana/web3.js';
import { Principal } from '@dfinity/principal';
import { HDNodeWallet, SigningKey, computeAddress } from 'ethers';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';

/**
 * Derivation path components
 */
export interface DerivationPathComponents {
  /** Purpose (e.g., 44' for BIP44) */
  purpose: number;
  /** Coin type (e.g., 60' for ETH, 0' for BTC) */
  coinType: number;
  /** Account index */
  account: number;
  /** Change index (0 for external, 1 for internal) */
  change: number;
  /** Address index */
  index: number;
}

/**
 * Derived key information
 */
export interface DerivedKey {
  /** Private key (hex) */
  privateKey: string;
  /** Public key (hex) */
  publicKey: string;
  /** Address (chain-specific format) */
  address: string;
  /** Derivation path used */
  derivationPath: string;
}

/**
 * Default derivation paths for different chains
 */
const DEFAULT_DERIVATION_PATHS: Record<string, string> = {
  // Ethereum / ckETH (BIP44)
  eth: "m/44'/60'/0'/0/0",
  // Polkadot (Substrate)
  polkadot: "//hard//stash",
  // Solana (BIP44)
  solana: "m/44'/501'/0'/0'/0'",
  // ICP (BIP44 coin type 223)
  icp: "m/44'/223'/0'/0/0",
  // Arweave (BIP44 coin type 472)
  arweave: "m/44'/472'/0'/0/0",
  // Bitcoin
  btc: "m/44'/0'/0'/0/0",
};

/**
 * Parse derivation path string
 *
 * @param path - Derivation path string (e.g., "m/44'/60'/0'/0/0")
 * @returns Parsed path components
 */
export function parseDerivationPath(path: string): DerivationPathComponents {
  const parts = path.split('/');

  if (parts[0] !== 'm') {
    throw new Error('Invalid derivation path: must start with "m"');
  }

  const components: DerivationPathComponents = {
    purpose: 0,
    coinType: 0,
    account: 0,
    change: 0,
    index: 0,
  };

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]?.replace(/'/g, '') || '0';
    const num = parseInt(part, 10);

    switch (i) {
      case 1:
        components.purpose = num;
        break;
      case 2:
        components.coinType = num;
        break;
      case 3:
        components.account = num;
        break;
      case 4:
        components.change = num;
        break;
      case 5:
        components.index = num;
        break;
    }
  }

  return components;
}

/**
 * Build derivation path from components
 *
 * @param components - Path components
 * @returns Derivation path string
 */
export function buildDerivationPath(
  components: DerivationPathComponents
): string {
  const parts = ['m'];

  parts.push(`${components.purpose}'`);
  parts.push(`${components.coinType}'`);
  parts.push(`${components.account}'`);
  parts.push(`${components.change}`);
  parts.push(`${components.index}`);

  return parts.join('/');
}

/**
 * Validate seed phrase (BIP39)
 *
 * @param seedPhrase - Seed phrase to validate
 * @returns True if valid BIP39 phrase
 */
export function validateSeedPhrase(seedPhrase: string): boolean {
  return bip39.validateMnemonic(seedPhrase);
}

/**
 * Generate seed from seed phrase
 *
 * @param seedPhrase - BIP39 seed phrase
 * @param passphrase - Optional passphrase (default empty)
 * @returns Seed bytes
 */
export function generateSeedFromMnemonic(
  seedPhrase: string,
  passphrase: string = ''
): Buffer {
  return bip39.mnemonicToSeedSync(seedPhrase, passphrase);
}

/**
 * Generate mnemonic from entropy
 *
 * @param strength - Entropy strength in bits (128, 160, 192, 224, 256)
 * @param rng - Optional RNG function
 * @returns BIP39 mnemonic phrase
 */
export function generateMnemonic(
  strength: number = 128,
  rng?: (size: number) => Buffer
): string {
  return bip39.generateMnemonic(strength, rng);
}

/**
 * Derive key from seed using HMAC-SHA512
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path
 * @returns Derived key (32 bytes private, 32 bytes chain code)
 */
function deriveKeyFromSeed(
  seed: Buffer,
  derivationPath: string
): { privateKey: Buffer; chainCode: Buffer } {
  const parts = parseDerivationPath(derivationPath);

  let key: Buffer = seed.slice(0, 32);
  let chainCode: Buffer = seed.slice(32, 64);

  for (const part of [parts.purpose, parts.coinType, parts.account, parts.change, parts.index]) {
    const isHardened = part >= 0x80000000;

    const data = Buffer.concat([
      key,
      Buffer.from([0x00]),
      Buffer.alloc(4),
    ]);

    data.writeUint32BE(isHardened ? part : part + 0x80000000, 4);

    const hmac = crypto.createHmac('sha512', chainCode);
    hmac.update(data);

    const result = hmac.digest();
    key = result.slice(0, 32);
    chainCode = result.slice(32, 64);
  }

  return { privateKey: key, chainCode };
}

/**
 * Derive Ethereum-compatible key
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "m/44'/60'/0'/0/0")
 * @returns Derived key with ETH address
 */
export function deriveEthKey(
  seed: Buffer,
  derivationPath: string = DEFAULT_DERIVATION_PATHS.eth!
): DerivedKey {
  const root = HDNodeWallet.fromSeed(seed);
  const node = root.derivePath(derivationPath);

  const privateKeyHex = stripHexPrefix(node.privateKey);
  const publicKeyHex = stripHexPrefix(SigningKey.computePublicKey(node.privateKey, false));
  const address = node.address;

  return {
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
    address,
    derivationPath,
  };
}

/**
 * Derive Polkadot-compatible key
 *
 * Uses secp256k1 (via @noble/curves) for key derivation and SS58 for address
 * encoding.
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "//hard//stash")
 * @returns Derived key with Polkadot address
 */
export function derivePolkadotKey(
  seed: Buffer,
  derivationPath: string = DEFAULT_DERIVATION_PATHS.polkadot!
): DerivedKey {
  const privateKey = seed.slice(0, 32);

  const publicKey = deriveSecp256k1PublicKey(privateKey);

  const address = derivePolkadotAddress(Buffer.from(publicKey));

  return {
    privateKey: privateKey.toString('hex'),
    publicKey: publicKey.toString('hex'),
    address,
    derivationPath,
  };
}

/**
 * Derive Solana-compatible key
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "m/44'/501'/0'/0'/0'")
 * @returns Derived key with Solana address
 */
export function deriveSolanaKey(
  seed: Buffer,
  derivationPath: string = DEFAULT_DERIVATION_PATHS.solana!
): DerivedKey {
  const derived = deriveKeyFromSeed(seed, derivationPath);

  if (!derived || !derived.privateKey) {
    throw new Error('Failed to derive Solana key');
  }

  // Solana uses Ed25519; Keypair is used here for its base58 address encoding.
  const privateKeyBytes = derived.privateKey.subarray(0, 32);
  const keypair = Keypair.fromSeed(privateKeyBytes);

  return {
    privateKey: Buffer.from(keypair.secretKey).toString('hex'),
    publicKey: Buffer.from(keypair.publicKey.toBytes()).toString('hex'),
    address: keypair.publicKey.toBase58(),
    derivationPath,
  };
}

/**
 * Derive ICP-compatible key
 *
 * Uses Ed25519 via @noble/curves to match the ICP identity standard.
 * Private key stored as 32 bytes (raw scalar); public key 32 bytes.
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "m/44'/223'/0'/0/0")
 * @returns Derived key with ICP principal address
 */
export function deriveIcpKey(
  seed: Buffer,
  derivationPath: string = DEFAULT_DERIVATION_PATHS.icp!
): DerivedKey {
  const derived = deriveKeyFromSeed(seed, derivationPath);
  const privateKey = derived.privateKey.subarray(0, 32);
  const publicKey = ed25519.getPublicKey(privateKey);

  return {
    privateKey: Buffer.from(privateKey).toString('hex'),
    publicKey: Buffer.from(publicKey).toString('hex'),
    address: deriveIcpPrincipalAddress(publicKey),
    derivationPath,
  };
}

/**
 * Derive Arweave-compatible key
 *
 * Uses Ed25519 via @noble/curves for key generation; the address is
 * SHA-256(publicKey) encoded as base64url (43 chars).
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "m/44'/472'/0'/0/0")
 * @returns Derived key with Arweave address
 */
export function deriveArweaveKey(
  seed: Buffer,
  derivationPath: string = DEFAULT_DERIVATION_PATHS.arweave!
): DerivedKey {
  const derived = deriveKeyFromSeed(seed, derivationPath);
  const privateKey = derived.privateKey.subarray(0, 32);
  const publicKey = ed25519.getPublicKey(privateKey);

  return {
    privateKey: Buffer.from(privateKey).toString('hex'),
    publicKey: Buffer.from(publicKey).toString('hex'),
    address: deriveArweaveAddress(publicKey),
    derivationPath,
  };
}

/**
 * Derive secp256k1 uncompressed public key (65 bytes) from a 32-byte private
 * key using @noble/curves/secp256k1.
 */
function deriveSecp256k1PublicKey(privateKey: Buffer): Buffer {
  return Buffer.from(secp256k1.getPublicKey(privateKey, false));
}

/**
 * Derive Polkadot address from public key
 *
 * Uses proper SS58 encoding with Polkadot prefix (0).
 *
 * @param publicKey - Public key bytes (32 bytes for SR25519/ED25519)
 * @returns Polkadot address (SS58 format)
 */
function derivePolkadotAddress(publicKey: Buffer): string {
  if (publicKey.length !== 32) {
    throw new Error(`Invalid public key length: expected 32 bytes, got ${publicKey.length}`);
  }

  try {
    const address = encodeAddress(publicKey, 0);
    return address;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to derive Polkadot address: ${message}`);
  }
}

/**
 * Get default derivation path for chain
 *
 * @param chain - Blockchain type
 * @returns Default derivation path
 */
export function getDefaultDerivationPath(chain: string): string {
  switch (chain.toLowerCase()) {
    case 'cketh':
    case 'ethereum':
    case 'eth':
      return DEFAULT_DERIVATION_PATHS.eth!;
    case 'polkadot':
    case 'dot':
      return DEFAULT_DERIVATION_PATHS.polkadot!;
    case 'solana':
    case 'sol':
      return DEFAULT_DERIVATION_PATHS.solana!;
    case 'icp':
      return DEFAULT_DERIVATION_PATHS.icp!;
    case 'ar':
    case 'arweave':
      return DEFAULT_DERIVATION_PATHS.arweave!;
    default:
      return DEFAULT_DERIVATION_PATHS.eth!;
  }
}

/**
 * Derive wallet key based on creation method
 *
 * @param method - Wallet creation method
 * @param seedPhrase - Seed phrase (for 'seed' and 'mnemonic' methods)
 * @param privateKey - Private key (for 'private-key' method)
 * @param derivationPath - Custom derivation path
 * @param chain - Blockchain type
 * @returns Derived key information
 */
export function deriveWalletKey(
  method: WalletCreationMethod,
  seedPhrase?: string,
  privateKey?: string,
  derivationPath?: string,
  chain: string = 'cketh'
): DerivedKey {
  const normalizedChain = chain.toLowerCase();
  const effectiveDerivationPath =
    derivationPath || getDefaultDerivationPath(normalizedChain);

  if (method === 'private-key' && privateKey) {
    const normalizedPrivateKey = normalizePrivateKey(privateKey);
    const privateKeyBuffer = Buffer.from(stripHexPrefix(normalizedPrivateKey), 'hex');

    let address: string;
    let publicKeyHex: string;

    if (normalizedChain === 'cketh' || normalizedChain === 'ethereum' || normalizedChain === 'eth') {
      publicKeyHex = stripHexPrefix(SigningKey.computePublicKey(normalizedPrivateKey, false));
      address = computeAddress(normalizedPrivateKey);
    } else if (normalizedChain === 'polkadot' || normalizedChain === 'dot') {
      const publicKey = deriveSecp256k1PublicKey(privateKeyBuffer);
      publicKeyHex = publicKey.toString('hex');
      address = derivePolkadotAddress(publicKey);
    } else if (normalizedChain === 'solana' || normalizedChain === 'sol') {
      // Solana accepts either 32-byte seed or 64-byte secret key material.
      const keypair = privateKeyBuffer.length >= 64
        ? Keypair.fromSecretKey(privateKeyBuffer.subarray(0, 64))
        : Keypair.fromSeed(privateKeyBuffer.subarray(0, 32));
      publicKeyHex = Buffer.from(keypair.publicKey.toBytes()).toString('hex');
      address = keypair.publicKey.toBase58();
    } else if (normalizedChain === 'icp') {
      // Ed25519 via @noble/curves – 32-byte seed -> 32-byte public key
      const seed = privateKeyBuffer.slice(0, 32);
      const publicKey = ed25519.getPublicKey(seed);
      publicKeyHex = Buffer.from(publicKey).toString('hex');
      address = deriveIcpPrincipalAddress(publicKey);
    } else if (normalizedChain === 'arweave' || normalizedChain === 'ar') {
      // Ed25519 via @noble/curves – address is SHA-256(pubkey) in base64url
      const seed = privateKeyBuffer.slice(0, 32);
      const publicKey = ed25519.getPublicKey(seed);
      publicKeyHex = Buffer.from(publicKey).toString('hex');
      address = deriveArweaveAddress(publicKey);
    } else {
      throw new Error(`Unsupported chain for private key derivation: ${chain}`);
    }

    return {
      privateKey: stripHexPrefix(normalizedPrivateKey),
      publicKey: publicKeyHex,
      address,
      derivationPath: effectiveDerivationPath,
    };
  }

  if ((method === 'seed' || method === 'mnemonic') && seedPhrase) {
    // Derive from seed phrase
    if (!validateSeedPhrase(seedPhrase)) {
      throw new Error('Invalid seed phrase');
    }

    const seed = generateSeedFromMnemonic(seedPhrase);

    if (normalizedChain === 'cketh' || normalizedChain === 'ethereum' || normalizedChain === 'eth') {
      return deriveEthKey(seed, effectiveDerivationPath);
    } else if (normalizedChain === 'polkadot' || normalizedChain === 'dot') {
      return derivePolkadotKey(seed, effectiveDerivationPath);
    } else if (normalizedChain === 'solana' || normalizedChain === 'sol') {
      return deriveSolanaKey(seed, effectiveDerivationPath);
    } else if (normalizedChain === 'icp') {
      return deriveIcpKey(seed, effectiveDerivationPath);
    } else if (normalizedChain === 'arweave' || normalizedChain === 'ar') {
      return deriveArweaveKey(seed, effectiveDerivationPath);
    } else {
      throw new Error(`Unsupported chain for seed derivation: ${chain}`);
    }
  }

  throw new Error(`Invalid wallet creation method: ${method}`);
}

function stripHexPrefix(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

function normalizePrivateKey(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
}

function deriveIcpPrincipalAddress(publicKeyBytes: Uint8Array): string {
  return Principal.selfAuthenticating(publicKeyBytes).toText();
}

function deriveArweaveAddress(publicKeyBytes: Uint8Array): string {
  const digest = crypto.createHash('sha256').update(publicKeyBytes).digest();
  return digest.toString('base64url');
}
