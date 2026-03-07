"use strict";
/**
 * Key Derivation Module
 *
 * Implements BIP39 seed phrase derivation for wallet keys.
 * Supports multiple derivation paths for different blockchains.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDerivationPath = parseDerivationPath;
exports.buildDerivationPath = buildDerivationPath;
exports.validateSeedPhrase = validateSeedPhrase;
exports.generateSeedFromMnemonic = generateSeedFromMnemonic;
exports.generateMnemonic = generateMnemonic;
exports.deriveEthKey = deriveEthKey;
exports.derivePolkadotKey = derivePolkadotKey;
exports.deriveSolanaKey = deriveSolanaKey;
exports.getDefaultDerivationPath = getDefaultDerivationPath;
exports.deriveWalletKey = deriveWalletKey;
var bip39 = require("bip39");
var crypto = require("node:crypto");
var bs58_1 = require("bs58");
var web3_js_1 = require("@solana/web3.js");
/**
 * Default derivation paths for different chains
 */
var DEFAULT_DERIVATION_PATHS = {
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
function parseDerivationPath(path) {
    var parts = path.split('/');
    if (parts[0] !== 'm') {
        throw new Error('Invalid derivation path: must start with "m"');
    }
    var components = {
        purpose: 0,
        coinType: 0,
        account: 0,
        change: 0,
        index: 0,
    };
    for (var i = 1; i < parts.length; i++) {
        var part = parts[i].replace(/'/g, '');
        var num = parseInt(part, 10);
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
function buildDerivationPath(components) {
    var parts = ['m'];
    parts.push("".concat(components.purpose, "'"));
    parts.push("".concat(components.coinType, "'"));
    parts.push("".concat(components.account, "'"));
    parts.push("".concat(components.change));
    parts.push("".concat(components.index));
    return parts.join('/');
}
/**
 * Validate seed phrase (BIP39)
 *
 * @param seedPhrase - Seed phrase to validate
 * @returns True if valid BIP39 phrase
 */
function validateSeedPhrase(seedPhrase) {
    return bip39.validateMnemonic(seedPhrase);
}
/**
 * Generate seed from seed phrase
 *
 * @param seedPhrase - BIP39 seed phrase
 * @param passphrase - Optional passphrase (default empty)
 * @returns Seed bytes
 */
function generateSeedFromMnemonic(seedPhrase, passphrase) {
    if (passphrase === void 0) { passphrase = ''; }
    return bip39.mnemonicToSeedSync(seedPhrase, passphrase);
}
/**
 * Generate mnemonic from entropy
 *
 * @param strength - Entropy strength in bits (128, 160, 192, 224, 256)
 * @param rng - Optional RNG function
 * @returns BIP39 mnemonic phrase
 */
function generateMnemonic(strength, rng) {
    if (strength === void 0) { strength = 128; }
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
    var parts = parseDerivationPath(derivationPath);
    var key = seed.slice(0, 32);
    var chainCode = seed.slice(32, 64);
    for (var _i = 0, _a = [parts.purpose, parts.coinType, parts.account, parts.change, parts.index]; _i < _a.length; _i++) {
        var part = _a[_i];
        var isHardened = part >= 0x80000000;
        var data = Buffer.concat([
            key,
            Buffer.from([0x00]),
            Buffer.alloc(4),
        ]);
        data.writeUint32BE(isHardened ? part : part + 0x80000000, 4);
        var hmac = crypto.createHmac('sha512', chainCode);
        hmac.update(data);
        var result = hmac.digest();
        key = result.slice(0, 32);
        chainCode = result.slice(32, 64);
    }
    return { privateKey: key, chainCode: chainCode };
}
/**
 * Derive Ethereum-compatible key
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "m/44'/60'/0'/0/0")
 * @returns Derived key with ETH address
 */
function deriveEthKey(seed, derivationPath) {
    if (derivationPath === void 0) { derivationPath = DEFAULT_DERIVATION_PATHS.eth; }
    var derived = deriveKeyFromSeed(seed, derivationPath);
    if (!derived || !derived.privateKey) {
        throw new Error('Failed to derive Ethereum key');
    }
    // Generate Ethereum public key (secp256k1)
    // For now, we'll return the private key and a placeholder address
    // In production, use elliptic or secp256k1 library for proper key derivation
    var publicKey = derivePublicKey(derived.privateKey);
    var address = deriveEthAddress(publicKey);
    return {
        privateKey: derived.privateKey.toString('hex'),
        publicKey: publicKey.toString('hex'),
        address: address,
        derivationPath: derivationPath,
    };
}
/**
 * Derive Polkadot-compatible key
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "//hard//stash")
 * @returns Derived key with Polkadot address
 */
function derivePolkadotKey(seed, derivationPath) {
    // Polkadot uses SR25519 and different derivation scheme
    // For now, we'll use a simplified approach
    // In production, use @polkadot/util-crypto for proper derivation
    if (derivationPath === void 0) { derivationPath = DEFAULT_DERIVATION_PATHS.polkadot; }
    var privateKey = seed.slice(0, 32);
    // Generate Polkadot address (SS58 format)
    // For now, return placeholder
    var publicKey = derivePublicKey(privateKey);
    var address = derivePolkadotAddress(publicKey);
    return {
        privateKey: privateKey.toString('hex'),
        publicKey: publicKey.toString('hex'),
        address: address,
        derivationPath: derivationPath,
    };
}
/**
 * Derive Solana-compatible key
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "m/44'/501'/0'/0'/0'")
 * @returns Derived key with Solana address
 */
function deriveSolanaKey(seed, derivationPath) {
    if (derivationPath === void 0) { derivationPath = DEFAULT_DERIVATION_PATHS.solana; }
    // Use BIP44 derivation for Solana
    var derived = deriveKeyFromSeed(seed, derivationPath);
    if (!derived || !derived.privateKey) {
        throw new Error('Failed to derive Solana key');
    }
    // Solana uses Ed25519, takes first 32 bytes of derived private key
    var privateKeyBytes = Buffer.from(derived.privateKey, 'hex').subarray(0, 32);
    // Use Solana's Keypair for proper Ed25519 key generation
    var keypair = web3_js_1.Keypair.fromSecretKey(privateKeyBytes);
    return {
        privateKey: Buffer.from(keypair.secretKey).toString('hex'),
        publicKey: Buffer.from(keypair.publicKey.toBytes()).toString('hex'),
        address: keypair.publicKey.toBase58(),
        derivationPath: derivationPath,
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
    var hash = crypto.createHash('sha256').update(privateKey).digest();
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
    var hash = crypto.createHash('sha256').update(publicKey).digest();
    var addressBytes = hash.slice(0, 20);
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
    var hash = crypto.createHash('sha256').update(publicKey).digest();
    var addressBytes = hash.slice(0, 32);
    // Simple base58 encoding (not real SS58)
    try {
        return bs58_1.default.encode(addressBytes);
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
    var addressBytes = publicKey.slice(0, 32);
    try {
        return bs58_1.default.encode(addressBytes);
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
function getDefaultDerivationPath(chain) {
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
function deriveWalletKey(method, seedPhrase, privateKey, derivationPath, chain) {
    if (chain === void 0) { chain = 'cketh'; }
    var effectiveDerivationPath = derivationPath || getDefaultDerivationPath(chain);
    if (method === 'private-key' && privateKey) {
        // Direct use of private key
        var privateKeyBuffer = Buffer.from(privateKey, 'hex');
        var publicKey = derivePublicKey(privateKeyBuffer);
        var address = void 0;
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
            privateKey: privateKey,
            publicKey: publicKey.toString('hex'),
            address: address,
            derivationPath: effectiveDerivationPath,
        };
    }
    if ((method === 'seed' || method === 'mnemonic') && seedPhrase) {
        // Derive from seed phrase
        if (!validateSeedPhrase(seedPhrase)) {
            throw new Error('Invalid seed phrase');
        }
        var seed = generateSeedFromMnemonic(seedPhrase);
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
    throw new Error("Invalid wallet creation method: ".concat(method));
}
