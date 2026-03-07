/**
 * CBOR Serializer/Deserializer
 *
 * Uses cbor-x to encode/decode wallet data and transactions.
 * Provides efficient binary serialization for wallet operations.
 */
import * as cbor from 'cbor-x';
/**
 * Serialize wallet data to CBOR
 *
 * @param wallet - Wallet data to serialize
 * @param options - CBOR encoding options
 * @returns CBOR-encoded wallet data
 */
export function serializeWallet(wallet, _options = {}) {
    try {
        const walletObject = {
            id: wallet.id,
            agentId: wallet.agentId,
            chain: wallet.chain,
            address: wallet.address,
            privateKey: wallet.privateKey,
            mnemonic: wallet.mnemonic,
            seedDerivationPath: wallet.seedDerivationPath,
            createdAt: wallet.createdAt,
            updatedAt: wallet.updatedAt,
            creationMethod: wallet.creationMethod,
            chainMetadata: wallet.chainMetadata,
        };
        const encoded = cbor.encode(walletObject);
        // Add checksum for tamper detection
        const checksum = calculateChecksum(encoded);
        const withChecksum = new Uint8Array(encoded.length + checksum.length);
        withChecksum.set(encoded);
        withChecksum.set(checksum, encoded.length);
        return withChecksum;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to serialize wallet: ${message}`);
    }
}
/**
 * Deserialize CBOR data to wallet
 *
 * @param data - CBOR-encoded wallet data
 * @returns Deserialized wallet data
 */
export function deserializeWallet(data) {
    try {
        // Verify checksum
        const checksumLength = 4;
        if (data.length < checksumLength) {
            throw new Error('Invalid wallet data: too short');
        }
        const payload = data.slice(0, -checksumLength);
        const checksum = data.slice(-checksumLength);
        const expectedChecksum = calculateChecksum(payload);
        if (!buffersEqual(checksum, expectedChecksum)) {
            throw new Error('Invalid wallet data: checksum mismatch');
        }
        const decoded = cbor.decode(payload);
        if (!decoded) {
            throw new Error('Invalid wallet data: decode failed');
        }
        return {
            id: decoded.id || '',
            agentId: decoded.agentId || '',
            chain: decoded.chain || 'cketh',
            address: decoded.address || '',
            privateKey: decoded.privateKey,
            mnemonic: decoded.mnemonic,
            seedDerivationPath: decoded.seedDerivationPath,
            createdAt: decoded.createdAt || Date.now(),
            updatedAt: decoded.updatedAt || Date.now(),
            creationMethod: decoded.creationMethod || 'seed',
            chainMetadata: decoded.chainMetadata,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to deserialize wallet: ${message}`);
    }
}
/**
 * Serialize transaction to CBOR
 *
 * @param transaction - Transaction to serialize
 * @returns CBOR-encoded transaction
 */
export function serializeTransaction(transaction) {
    try {
        const txObject = {
            hash: transaction.hash,
            from: transaction.from,
            to: transaction.to,
            amount: transaction.amount,
            chain: transaction.chain,
            timestamp: transaction.timestamp,
            status: transaction.status,
            fee: transaction.fee,
            data: transaction.data,
        };
        return cbor.encode(txObject);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to serialize transaction: ${message}`);
    }
}
/**
 * Deserialize CBOR data to transaction
 *
 * @param data - CBOR-encoded transaction data
 * @returns Deserialized transaction
 */
export function deserializeTransaction(data) {
    try {
        const decoded = cbor.decode(data);
        return {
            hash: decoded.hash || '',
            from: decoded.from || '',
            to: decoded.to || '',
            amount: decoded.amount || '0',
            chain: decoded.chain || 'cketh',
            timestamp: decoded.timestamp || Date.now(),
            status: decoded.status || 'pending',
            fee: decoded.fee,
            data: decoded.data,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to deserialize transaction: ${message}`);
    }
}
/**
 * Serialize transaction request to CBOR
 *
 * @param request - Transaction request to serialize
 * @returns CBOR-encoded transaction request
 */
export function serializeTransactionRequest(request) {
    try {
        const requestObject = {
            to: request.to,
            amount: request.amount,
            chain: request.chain,
            memo: request.memo,
            gasPrice: request.gasPrice,
            gasLimit: request.gasLimit,
        };
        return cbor.encode(requestObject);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to serialize transaction request: ${message}`);
    }
}
/**
 * Deserialize CBOR data to transaction request
 *
 * @param data - CBOR-encoded transaction request data
 * @returns Deserialized transaction request
 */
export function deserializeTransactionRequest(data) {
    try {
        const decoded = cbor.decode(data);
        return {
            to: decoded.to || '',
            amount: decoded.amount || '0',
            chain: decoded.chain || 'cketh',
            memo: decoded.memo,
            gasPrice: decoded.gasPrice,
            gasLimit: decoded.gasLimit,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to deserialize transaction request: ${message}`);
    }
}
/**
 * Serialize signed transaction to CBOR
 *
 * @param signedTx - Signed transaction to serialize
 * @returns CBOR-encoded signed transaction
 */
export function serializeSignedTransaction(signedTx) {
    try {
        const txObject = {
            txHash: signedTx.txHash,
            signedTx: signedTx.signedTx,
            signature: signedTx.signature,
            request: signedTx.request,
        };
        return cbor.encode(txObject);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to serialize signed transaction: ${message}`);
    }
}
/**
 * Deserialize CBOR data to signed transaction
 *
 * @param data - CBOR-encoded signed transaction data
 * @returns Deserialized signed transaction
 */
export function deserializeSignedTransaction(data) {
    try {
        const decoded = cbor.decode(data);
        return {
            txHash: decoded.txHash || '',
            signedTx: decoded.signedTx || '',
            signature: decoded.signature,
            request: decoded.request,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to deserialize signed transaction: ${message}`);
    }
}
/**
 * Calculate checksum for data integrity
 *
 * @param data - Data to checksum
 * @returns 4-byte checksum
 */
function calculateChecksum(data) {
    let checksum = 0;
    for (let i = 0; i < data.length; i++) {
        checksum = ((checksum << 8) ^ data[i]) >>> 0;
    }
    const result = new Uint8Array(4);
    const view = new DataView(result.buffer);
    view.setUint32(0, checksum, false); // Big-endian
    return result;
}
/**
 * Compare two buffers for equality
 *
 * @param a - First buffer
 * @param b - Second buffer
 * @returns True if buffers are equal
 */
function buffersEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}
/**
 * Validate CBOR data structure
 *
 * @param data - CBOR-encoded data
 * @returns True if data appears valid
 */
export function validateCborData(data) {
    try {
        // Attempt to decode
        const decoded = cbor.decode(data);
        // Check if it's an object
        if (!decoded || typeof decoded !== 'object' || decoded === null) {
            return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
