/**
 * Key Derivation Module
 *
 * Implements BIP39 seed phrase derivation for wallet keys.
 * Supports multiple derivation paths for different blockchains.
 */
import * as bip39 from 'bip39';
import * as crypto from 'node:crypto';
import bs58 from 'bs58';
/**
 * Default derivation paths for different chains
 */
const DEFAULT_DERIVATION_PATHS = {
    // Ethereum / ckETH (BIP44)
    eth: "m/44'/60'/0'/0/0",
    // Polkadot (Substrate)
    polkadot: "//hard//stash",
    // Solana (BIP44)
    solana: "m/44'/501'/0'/0'/0'",
    // Bitcoin
    btc: "m/44'/0'/0'/0/0",
};
/**
 * Parse derivation path string
 *
 * @param path - Derivation path string (e.g., "m/44'/60'/0'/0/0")
 * @returns Parsed path components
 */
export function parseDerivationPath(path) {
    const parts = path.split('/');
    if (parts[0] !== 'm') {
        throw new Error('Invalid derivation path: must start with "m"');
    }
    const components = {
        purpose: 0,
        coinType: 0,
        account: 0,
        change: 0,
        index: 0,
    };
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i].replace(/'/g, '');
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
export function buildDerivationPath(components) {
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
export function validateSeedPhrase(seedPhrase) {
    return bip39.validateMnemonic(seedPhrase);
}
/**
 * Generate seed from seed phrase
 *
 * @param seedPhrase - BIP39 seed phrase
 * @param passphrase - Optional passphrase (default empty)
 * @returns Seed bytes
 */
export function generateSeedFromMnemonic(seedPhrase, passphrase = '') {
    return bip39.mnemonicToSeedSync(seedPhrase, passphrase);
}
/**
 * Generate mnemonic from entropy
 *
 * @param strength - Entropy strength in bits (128, 160, 192, 224, 256)
 * @param rng - Optional RNG function
 * @returns BIP39 mnemonic phrase
 */
export function generateMnemonic(strength = 128, rng) {
    return bip39.generateMnemonic(strength, rng);
}
/**
 * Derive key from seed using HMAC-SHA512
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path
 * @returns Derived key (32 bytes private, 32 bytes chain code)
 */
function deriveKeyFromSeed(seed, derivationPath) {
    const parts = parseDerivationPath(derivationPath);
    let key = seed.slice(0, 32);
    let chainCode = seed.slice(32, 64);
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
export function deriveEthKey(seed, derivationPath = DEFAULT_DERIVATION_PATHS.eth) {
    const derived = deriveKeyFromSeed(seed, derivationPath);
    if (!derived || !derived.privateKey) {
        throw new Error('Failed to derive Ethereum key');
    }
    // Generate Ethereum public key (secp256k1)
    // For now, we'll return the private key and a placeholder address
    // In production, use elliptic or secp256k1 library for proper key derivation
    const publicKey = derivePublicKey(derived.privateKey);
    const address = deriveEthAddress(publicKey);
    return {
        privateKey: derived.privateKey.toString('hex'),
        publicKey: publicKey.toString('hex'),
        address,
        derivationPath,
    };
}
/**
 * Derive Polkadot-compatible key
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "//hard//stash")
 * @returns Derived key with Polkadot address
 */
export function derivePolkadotKey(seed, derivationPath = DEFAULT_DERIVATION_PATHS.polkadot) {
    // Polkadot uses SR25519 and different derivation scheme
    // For now, we'll use a simplified approach
    // In production, use @polkadot/util-crypto for proper derivation
    const privateKey = seed.slice(0, 32);
    // Generate Polkadot address (SS58 format)
    // For now, return placeholder
    const publicKey = derivePublicKey(privateKey);
    const address = derivePolkadotAddress(publicKey);
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
export function deriveSolanaKey(seed, derivationPath = DEFAULT_DERIVATION_PATHS.solana) {
    // Solana uses Ed25519
    // For now, we'll use a simplified approach
    // In production, use @solana/web3.js for proper key derivation
    const privateKey = seed.slice(0, 32);
    // Generate Solana public key (Ed25519)
    const publicKey = derivePublicKey(privateKey);
    const address = deriveSolanaAddress(publicKey);
    return {
        privateKey: privateKey.toString('hex'),
        publicKey: publicKey.toString('hex'),
        address,
        derivationPath,
    };
}
/**
 * Derive public key from private key (simplified)
 *
 * @param privateKey - Private key bytes
 * @returns Public key bytes
 */
function derivePublicKey(privateKey) {
    // This is a simplified version
    // In production, use proper elliptic curve libraries:
    // - Ethereum: secp256k1
    // - Polkadot: sr25519
    // - Solana: ed25519
    // For now, generate a deterministic public key from private key
    const hash = crypto.createHash('sha256').update(privateKey).digest();
    return hash.slice(0, 32);
}
/**
 * Derive Ethereum address from public key
 *
 * @param publicKey - Public key bytes
 * @returns Ethereum address
 */
function deriveEthAddress(publicKey) {
    // Simplified Ethereum address derivation
    // In production, use keccak256 and proper address derivation
    const hash = crypto.createHash('sha256').update(publicKey).digest();
    const addressBytes = hash.slice(0, 20);
    return '0x' + addressBytes.toString('hex');
}
/**
 * Derive Polkadot address from public key
 *
 * @param publicKey - Public key bytes
 * @returns Polkadot address (SS58 format)
 */
function derivePolkadotAddress(publicKey) {
    // Simplified Polkadot address derivation
    // In production, use SS58 encoding
    const hash = crypto.createHash('sha256').update(publicKey).digest();
    const addressBytes = hash.slice(0, 32);
    // Simple base58 encoding (not real SS58)
    try {
        return bs58.encode(addressBytes);
    }
    catch (error) {
        return 'placeholder-polkadot-address';
    }
}
/**
 * Derive Solana address from public key
 *
 * @param publicKey - Public key bytes
 * @returns Solana address (Base58 format)
 */
function deriveSolanaAddress(publicKey) {
    // Simplified Solana address derivation
    // In production, use proper Base58 encoding
    const addressBytes = publicKey.slice(0, 32);
    try {
        return bs58.encode(addressBytes);
    }
    catch (error) {
        return 'placeholder-solana-address';
    }
}
/**
 * Get default derivation path for chain
 *
 * @param chain - Blockchain type
 * @returns Default derivation path
 */
export function getDefaultDerivationPath(chain) {
    switch (chain.toLowerCase()) {
        case 'cketh':
        case 'ethereum':
        case 'eth':
            return DEFAULT_DERIVATION_PATHS.eth;
        case 'polkadot':
        case 'dot':
            return DEFAULT_DERIVATION_PATHS.polkadot;
        case 'solana':
        case 'sol':
            return DEFAULT_DERIVATION_PATHS.solana;
        default:
            return DEFAULT_DERIVATION_PATHS.eth;
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
export function deriveWalletKey(method, seedPhrase, privateKey, derivationPath, chain = 'cketh') {
    const effectiveDerivationPath = derivationPath || getDefaultDerivationPath(chain);
    if (method === 'private-key' && privateKey) {
        // Direct use of private key
        const privateKeyBuffer = Buffer.from(privateKey, 'hex');
        const publicKey = derivePublicKey(privateKeyBuffer);
        let address;
        if (chain === 'cketh' || chain === 'ethereum') {
            address = deriveEthAddress(publicKey);
        }
        else if (chain === 'polkadot') {
            address = derivePolkadotAddress(publicKey);
        }
        else {
            address = deriveSolanaAddress(publicKey);
        }
        return {
            privateKey,
            publicKey: publicKey.toString('hex'),
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
        if (chain === 'cketh' || chain === 'ethereum') {
            return deriveEthKey(seed, effectiveDerivationPath);
        }
        else if (chain === 'polkadot') {
            return derivePolkadotKey(seed, effectiveDerivationPath);
        }
        else if (chain === 'solana') {
            return deriveSolanaKey(seed, effectiveDerivationPath);
        }
        else {
            return deriveEthKey(seed, effectiveDerivationPath);
        }
    }
    throw new Error(`Invalid wallet creation method: ${method}`);
}
